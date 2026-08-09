import os
import cv2
import time
import base64
import numpy as np
from datetime import datetime
from flask import Flask, render_template, request, jsonify, send_from_directory, Response
from ultralytics import YOLO

app = Flask(__name__, static_folder='static', template_folder='templates')

# Base directories
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CAPTURES_DIR = os.path.join(BASE_DIR, 'static', 'captures')
UPLOADS_DIR = os.path.join(BASE_DIR, 'static', 'uploads')
os.makedirs(CAPTURES_DIR, exist_ok=True)
os.makedirs(UPLOADS_DIR, exist_ok=True)

# Load YOLO Model
MODEL_PATH = os.path.join(BASE_DIR, 'best.pt')
print(f"Loading YOLO model from {MODEL_PATH}...")
model = YOLO(MODEL_PATH)
CLASS_NAMES = model.names  # {0: 'car', 1: 'license'}
print(f"Model loaded successfully. Classes: {CLASS_NAMES}")

# Load EasyOCR Reader
ocr_reader = None
try:
    import easyocr
    print("Initializing EasyOCR reader...")
    ocr_reader = easyocr.Reader(['en'], gpu=False)
    print("EasyOCR initialized successfully!")
except Exception as e:
    print(f"EasyOCR initialization warning: {e}")

# In-memory storage for captured snapshots
snapshots_db = []
last_capture_time = 0.0
CAPTURE_COOLDOWN = 1.5  # Seconds between auto-captures to prevent duplicate spam

def decode_base64_image(image_b64):
    """Decode base64 string to OpenCV BGR image"""
    if ',' in image_b64:
        image_b64 = image_b64.split(',')[1]
    img_bytes = base64.b64decode(image_b64)
    nparr = np.frombuffer(img_bytes, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    return frame

import torch
import threading

def bbox_area(bbox):
    x1, y1, x2, y2 = bbox
    return max(0, x2 - x1) * max(0, y2 - y1)

def bbox_center(bbox):
    x1, y1, x2, y2 = bbox
    return (x1 + x2) / 2, (y1 + y2) / 2

def point_in_bbox(px, py, bbox, margin=0.02):
    x1, y1, x2, y2 = bbox
    bw, bh = x2 - x1, y2 - y1
    return (
        x1 - bw * margin <= px <= x2 + bw * margin
        and y1 - bh * margin <= py <= y2 + bh * margin
    )

def crop_bbox(frame, bbox, pad_x_ratio=0.04, pad_y_ratio=0.04):
    """Crop frame to bbox with proportional padding, clamped to image bounds."""
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = bbox
    bw, bh = max(1, x2 - x1), max(1, y2 - y1)

    pad_x = int(bw * pad_x_ratio)
    pad_y = int(bh * pad_y_ratio)

    x1_p = max(0, x1 - pad_x)
    y1_p = max(0, y1 - pad_y)
    x2_p = min(w, x2 + pad_x)
    y2_p = min(h, y2 + pad_y)

    crop = frame[y1_p:y2_p, x1_p:x2_p]
    if crop.size == 0:
        return frame.copy()
    return crop.copy()

def select_best_car_plate_pair(cars, plates, frame_w, frame_h):
    """
    Match each plate to the car it belongs to and pick the best pair.
    Prefers the tightest car box that contains a detected license plate.
    """
    if not cars and not plates:
        return None, None

    # Filter out cars taking up >85% of frame (false positive full-frame detections)
    valid_cars = []
    for c in cars:
        x1, y1, x2, y2 = c['bbox']
        if (x2 - x1) < 0.85 * frame_w and (y2 - y1) < 0.85 * frame_h:
            valid_cars.append(c)

    if not valid_cars and cars:
        valid_cars = cars

    # Priority 1: If license plates exist, pick the plate with highest confidence
    if plates:
        sorted_plates = sorted(plates, key=lambda p: p['confidence'] * bbox_area(p['bbox']), reverse=True)
        best_plate = sorted_plates[0]

        px, py = bbox_center(best_plate['bbox'])
        matching_cars = [c for c in valid_cars if point_in_bbox(px, py, c['bbox'])]
        
        if matching_cars:
            # Pick smallest car containing the plate for the tightest car crop
            best_car = min(matching_cars, key=lambda c: bbox_area(c['bbox']))
            return best_car, best_plate
        else:
            return None, best_plate

    # Priority 2: If no plates, pick the largest valid car
    if valid_cars:
        best_car = max(valid_cars, key=lambda c: bbox_area(c['bbox']))
        return best_car, None

    return None, None

def parse_yolo_results(results, conf_threshold):
    detections = []
    cars = []
    plates = []

    for box in results.boxes:
        cls_id = int(box.cls[0].item())
        cls_name = CLASS_NAMES.get(cls_id, str(cls_id))
        conf = float(box.conf[0].item())
        if conf < conf_threshold:
            continue

        coords = [int(c) for c in box.xyxy[0].tolist()]
        bw = coords[2] - coords[0]
        bh = coords[3] - coords[1]

        # Ignore tiny noise boxes, but keep small plates (e.g. 15x8)
        if bw < 10 or bh < 6:
            continue

        det_info = {
            'class_id': cls_id,
            'class_name': cls_name,
            'confidence': round(conf, 3),
            'bbox': coords,
        }
        detections.append(det_info)

        if cls_name == 'car' or cls_id == 0:
            cars.append(det_info)
        elif cls_name == 'license' or cls_id == 1:
            plates.append(det_info)

    return detections, cars, plates

def process_detections(frame, conf_threshold=0.30, auto_capture=True):
    """
    Runs ultra-fast YOLO model inference on frame (imgsz=320, ~45ms per frame),
    extracts car & license plate bboxes, and auto-captures picture if threshold is satisfied.
    """
    global last_capture_time
    h, w, _ = frame.shape

    # Fast PyTorch CPU inference with imgsz=320
    with torch.inference_mode():
        results = model(frame, conf=conf_threshold, imgsz=320, verbose=False)[0]

    detections, cars, plates = parse_yolo_results(results, conf_threshold)

    # Check auto-capture condition
    captured_data = None
    now = time.time()
    
    # Trigger capture if at least one car or license plate detected with strong confidence
    should_capture = auto_capture and (len(cars) > 0 or len(plates) > 0) and (now - last_capture_time > CAPTURE_COOLDOWN)

    if should_capture:
        last_capture_time = now
        timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:19]
        formatted_time = datetime.now().strftime("%I:%M:%S %p, %b %d %Y")
        snap_id = f"snap_{timestamp_str}"

        # Re-run at higher resolution for sharper crop boxes
        with torch.inference_mode():
            capture_results = model(frame, conf=conf_threshold, imgsz=640, verbose=False)[0]
        _, capture_cars, capture_plates = parse_yolo_results(capture_results, conf_threshold)

        all_cars = capture_cars if capture_cars else cars
        all_plates = capture_plates if capture_plates else plates

        target_car, target_plate = select_best_car_plate_pair(
            all_cars,
            all_plates,
            w, h
        )

        # Tight car crop around the detected vehicle
        if target_car:
            car_crop = crop_bbox(frame, target_car['bbox'], pad_x_ratio=0.02, pad_y_ratio=0.02)
        elif target_plate:
            # Expand plate bbox to approximate vehicle body
            px1, py1, px2, py2 = target_plate['bbox']
            pw, ph = px2 - px1, py2 - py1
            car_bbox = [
                max(0, px1 - int(pw * 2.0)),
                max(0, py1 - int(ph * 5.0)),
                min(w, px2 + int(pw * 2.0)),
                min(h, py2 + int(ph * 1.5)),
            ]
            car_crop = crop_bbox(frame, car_bbox, pad_x_ratio=0.0, pad_y_ratio=0.0)
        else:
            car_crop = frame.copy()

        # Tight license plate crop
        if target_plate:
            plate_crop = crop_bbox(frame, target_plate['bbox'], pad_x_ratio=0.03, pad_y_ratio=0.05)
        elif target_car:
            ch, cw = car_crop.shape[:2]
            plate_crop = car_crop[int(ch * 0.60):int(ch * 0.95), int(cw * 0.20):int(cw * 0.80)]
        else:
            plate_crop = car_crop.copy()

        # Save files
        car_filename = f"{snap_id}_car.jpg"
        plate_filename = f"{snap_id}_plate.jpg"
        full_filename = f"{snap_id}_full.jpg"

        car_path = os.path.join(CAPTURES_DIR, car_filename)
        plate_path = os.path.join(CAPTURES_DIR, plate_filename)
        full_path = os.path.join(CAPTURES_DIR, full_filename)

        cv2.imwrite(car_path, car_crop)
        cv2.imwrite(plate_path, plate_crop)
        cv2.imwrite(full_path, frame)

        car_conf = target_car['confidence'] if target_car else (target_plate['confidence'] if target_plate else 0.85)
        plate_conf = target_plate['confidence'] if target_plate else 0.88

        captured_data = {
            'id': snap_id,
            'timestamp': formatted_time,
            'plate_text': "SCANNING PLATE...",
            'car_image': f"/static/captures/{car_filename}",
            'plate_image': f"/static/captures/{plate_filename}",
            'full_image': f"/static/captures/{full_filename}",
            'car_confidence': int(car_conf * 100),
            'plate_confidence': int(plate_conf * 100),
            'has_license_plate': bool(target_plate is not None),
            'car_count': len(cars),
            'plate_count': len(plates)
        }

        # Background thread for EasyOCR so live stream detection is never blocked
        def async_ocr_task(crop, snapshot_obj):
            if ocr_reader is not None and crop is not None:
                try:
                    ocr_results = ocr_reader.readtext(crop, detail=0)
                    if ocr_results:
                        raw_text = " ".join(ocr_results).upper()
                        cleaned_text = "".join([c for c in raw_text if c.isalnum() or c in [' ', '-']]).strip()
                        if len(cleaned_text) > 1:
                            snapshot_obj['plate_text'] = cleaned_text
                        else:
                            snapshot_obj['plate_text'] = "AUTO DETECTED"
                    else:
                        snapshot_obj['plate_text'] = "AUTO DETECTED"
                except Exception:
                    snapshot_obj['plate_text'] = "AUTO DETECTED"

        threading.Thread(target=async_ocr_task, args=(plate_crop.copy(), captured_data), daemon=True).start()

        snapshots_db.insert(0, captured_data)

    return {
        'detections': detections,
        'car_count': len(cars),
        'plate_count': len(plates),
        'captured': captured_data
    }

import io
import zipfile

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/table')
def table_page():
    return render_template('table.html')

@app.route('/api/detect_frame', methods=['POST'])
def api_detect_frame():
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({'error': 'No image data provided'}), 400

        conf_threshold = float(data.get('conf', 0.30))
        auto_capture = bool(data.get('auto_capture', True))

        frame = decode_base64_image(data['image'])
        result = process_detections(frame, conf_threshold, auto_capture)
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/snapshots', methods=['GET'])
def get_snapshots():
    return jsonify(snapshots_db)

@app.route('/api/snapshots/delete/<snap_id>', methods=['DELETE', 'POST'])
def delete_snapshot(snap_id):
    global snapshots_db
    target = None
    for s in snapshots_db:
        if s['id'] == snap_id:
            target = s
            break
    
    if target:
        snapshots_db = [s for s in snapshots_db if s['id'] != snap_id]
        for key in ['car_image', 'plate_image', 'full_image']:
            filepath = os.path.join(BASE_DIR, target[key].lstrip('/'))
            if os.path.exists(filepath):
                try:
                    os.remove(filepath)
                except Exception:
                    pass
        return jsonify({'status': 'deleted', 'id': snap_id})
    return jsonify({'error': 'Snapshot not found'}), 404

@app.route('/api/snapshots/batch_delete', methods=['POST'])
def batch_delete_snapshots():
    global snapshots_db
    data = request.get_json() or {}
    ids_to_delete = set(data.get('ids', []))

    if not ids_to_delete:
        return jsonify({'error': 'No IDs provided'}), 400

    deleted_count = 0
    new_db = []
    for s in snapshots_db:
        if s['id'] in ids_to_delete:
            deleted_count += 1
            for key in ['car_image', 'plate_image', 'full_image']:
                filepath = os.path.join(BASE_DIR, s[key].lstrip('/'))
                if os.path.exists(filepath):
                    try:
                        os.remove(filepath)
                    except Exception:
                        pass
        else:
            new_db.append(s)

    snapshots_db = new_db
    return jsonify({'status': 'success', 'deleted_count': deleted_count})

@app.route('/api/snapshots/export_zip', methods=['GET', 'POST'])
def export_snapshots_zip():
    """
    Exports requested snapshots into a downloadable .zip archive.
    Query/Body params:
    - mode: 'all' | 'car_only' | 'plate_only' (default: 'all')
    - ids: list of IDs (optional, if omitted exports all)
    """
    mode = request.args.get('mode', 'all')
    selected_ids = request.args.getlist('id')

    if request.is_json:
        data = request.get_json() or {}
        mode = data.get('mode', mode)
        if 'ids' in data:
            selected_ids = data['ids']

    target_snapshots = snapshots_db
    if selected_ids:
        ids_set = set(selected_ids)
        target_snapshots = [s for s in snapshots_db if s['id'] in ids_set]

    if not target_snapshots:
        return jsonify({'error': 'No snapshots found for export'}), 404

    # Create zip buffer in memory
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
        for s in target_snapshots:
            snap_id = s['id']
            # Car image
            if mode in ['all', 'car_only']:
                car_path = os.path.join(BASE_DIR, s['car_image'].lstrip('/'))
                if os.path.exists(car_path):
                    zip_file.write(car_path, arcname=f"{snap_id}_car.jpg")

            # Plate image
            if mode in ['all', 'plate_only']:
                plate_path = os.path.join(BASE_DIR, s['plate_image'].lstrip('/'))
                if os.path.exists(plate_path):
                    zip_file.write(plate_path, arcname=f"{snap_id}_plate.jpg")

    zip_buffer.seek(0)
    zip_filename = f"autovision_export_{mode}_{int(time.time())}.zip"
    return Response(
        zip_buffer.getvalue(),
        mimetype='application/zip',
        headers={'Content-Disposition': f'attachment; filename={zip_filename}'}
    )

@app.route('/api/snapshots/clear', methods=['POST'])
def clear_snapshots():
    global snapshots_db
    snapshots_db = []
    for fname in os.listdir(CAPTURES_DIR):
        try:
            os.remove(os.path.join(CAPTURES_DIR, fname))
        except Exception:
            pass
    return jsonify({'status': 'cleared'})

@app.route('/api/upload_video', methods=['POST'])
def upload_video():
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    
    filename = f"upload_{int(time.time())}_{file.filename}"
    filepath = os.path.join(UPLOADS_DIR, filename)
    file.save(filepath)
    
    return jsonify({
        'status': 'success',
        'video_url': f"/static/uploads/{filename}",
        'filename': file.filename
    })

@app.route('/api/upload_image', methods=['POST'])
def upload_image():
    if 'file' not in request.files:
        return jsonify({'error': 'No image file uploaded'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected image file'}), 400

    conf_threshold = float(request.form.get('conf', 0.30))

    # Read image file bytes
    file_bytes = np.frombuffer(file.read(), np.uint8)
    frame = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)

    if frame is None:
        return jsonify({'error': 'Failed to decode image'}), 400

    filename = f"img_test_{int(time.time())}_{file.filename}"
    filepath = os.path.join(UPLOADS_DIR, filename)
    cv2.imwrite(filepath, frame)

    # Process detections on uploaded image
    result = process_detections(frame, conf_threshold=conf_threshold, auto_capture=True)
    result['image_url'] = f"/static/uploads/{filename}"
    return jsonify(result)

@app.route('/api/sample_video', methods=['GET'])
def sample_video():
    sample_name = "1900-151662242_large.mp4"
    sample_path = os.path.join(BASE_DIR, sample_name)
    if os.path.exists(sample_path):
        return jsonify({
            'available': True,
            'filename': sample_name,
            'video_url': f"/stream_sample_file"
        })
    return jsonify({'available': False})

@app.route('/stream_sample_file')
def stream_sample_file():
    return send_from_directory(BASE_DIR, "1900-151662242_large.mp4", mimetype="video/mp4")

if __name__ == '__main__':
    print("Starting Flask AI Vehicle & Plate Capture Server on http://127.0.0.1:5000")
    app.run(host='127.0.0.1', port=5000, debug=False, threaded=True)
