/* ==========================================================================
   AUTOVISION AI - FRONTEND APPLICATION JAVASCRIPT
   ========================================================================== */

// STATE VARIABLES
let currentMode = 'video'; // 'video' | 'webcam'
let isProcessing = false;
let isPlaying = false;
let isWebcamActive = false;
let webcamStream = null;

let confThreshold = 0.25;
let autoCapture = false;

let frameCount = 0;
let lastFpsTime = performance.now();
let currentFps = 0;
let loopIntervalId = null;

// DOM ELEMENTS
const videoElement = document.getElementById('videoElement');
const webcamBufferCanvas = document.getElementById('webcamBufferCanvas');
const overlayCanvas = document.getElementById('overlayCanvas');
const overlayCtx = overlayCanvas.getContext('2d');

const hudModeBadge = document.getElementById('hudModeBadge');
const hudTargetBadge = document.getElementById('hudTargetBadge');
const hudCarCount = document.getElementById('hudCarCount');
const hudPlateCount = document.getElementById('hudPlateCount');
const fpsCounter = document.getElementById('fpsCounter');
const captureFlashNotice = document.getElementById('captureFlashNotice');

const videoControlsGroup = document.getElementById('videoControlsGroup');
const webcamControlsGroup = document.getElementById('webcamControlsGroup');

const btnPlayPause = document.getElementById('btnPlayPause');
const lblPlayPause = document.getElementById('lblPlayPause');
const btnStartWebcam = document.getElementById('btnStartWebcam');
const btnStopWebcam = document.getElementById('btnStopWebcam');

const galleryContainer = document.getElementById('galleryContainer');
const galleryCountBadge = document.getElementById('galleryCountBadge');

// INITIALIZATION
document.addEventListener('DOMContentLoaded', () => {
    setupCanvasResizing();
    loadSampleVideo();
    fetchSnapshots();
});

// CANVAS RESIZING & OVERLAY SYNC
function setupCanvasResizing() {
    const resize = () => {
        if (videoElement.videoWidth && videoElement.videoHeight) {
            const aspect = videoElement.videoWidth / videoElement.videoHeight;
            document.getElementById('viewportContainer').style.aspectRatio = `${aspect}`;
        }
        const rect = videoElement.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            overlayCanvas.width = Math.floor(rect.width);
            overlayCanvas.height = Math.floor(rect.height);
        }
    };
    window.addEventListener('resize', resize);
    videoElement.addEventListener('loadedmetadata', resize);
    resize();
}

// SOURCE MODE SWITCHER
function switchSourceMode(mode) {
    if (currentMode === mode) return;

    currentMode = mode;
    document.getElementById('tabVideo').classList.toggle('active', mode === 'video');
    document.getElementById('tabWebcam').classList.toggle('active', mode === 'webcam');
    document.getElementById('tabImage').classList.toggle('active', mode === 'image');

    const staticImg = document.getElementById('staticImageElement');
    const imageControlsGroup = document.getElementById('imageControlsGroup');

    if (mode === 'video') {
        stopWebcam();
        staticImg.style.display = 'none';
        videoElement.style.display = 'block';
        videoControlsGroup.style.display = 'flex';
        webcamControlsGroup.style.display = 'none';
        imageControlsGroup.style.display = 'none';
        hudModeBadge.innerHTML = '<i class="fa-solid fa-file-video"></i> MODE: VIDEO STREAM';
        loadSampleVideo();
    } else if (mode === 'webcam') {
        pauseVideo();
        staticImg.style.display = 'none';
        videoElement.style.display = 'block';
        videoControlsGroup.style.display = 'none';
        webcamControlsGroup.style.display = 'flex';
        imageControlsGroup.style.display = 'none';
        hudModeBadge.innerHTML = '<i class="fa-solid fa-camera"></i> MODE: LIVE WEBCAM';
    } else if (mode === 'image') {
        pauseVideo();
        stopWebcam();
        stopDetectionLoop();
        videoElement.style.display = 'none';
        staticImg.style.display = 'block';
        videoControlsGroup.style.display = 'none';
        webcamControlsGroup.style.display = 'none';
        imageControlsGroup.style.display = 'flex';
        hudModeBadge.innerHTML = '<i class="fa-solid fa-image"></i> MODE: PHOTO TEST';
        hudTargetBadge.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> SELECT A PHOTO TO DETECT';
        clearOverlay();
    }
}

// DIRECT IMAGE FILE UPLOAD HANDLING (Dedicated Button)
function handleDirectImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Automatically switch to Image Mode View
    switchSourceMode('image');

    const staticImg = document.getElementById('staticImageElement');
    const reader = new FileReader();
    reader.onload = (e) => {
        staticImg.src = e.target.result;
    };
    reader.readAsDataURL(file);

    hudTargetBadge.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> RUNNING AI DETECTION ON IMAGE...';

    const formData = new FormData();
    formData.append('file', file);
    formData.append('conf', confThreshold);

    fetch('/api/upload_image', {
        method: 'POST',
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        if (data.error) {
            alert("Image Error: " + data.error);
            return;
        }

        // Draw bounding box overlays on uploaded image
        const imgObj = new Image();
        imgObj.src = staticImg.src;
        imgObj.onload = () => {
            overlayCanvas.width = staticImg.clientWidth || overlayCanvas.clientWidth;
            overlayCanvas.height = staticImg.clientHeight || overlayCanvas.clientHeight;
            drawOverlay(data.detections, imgObj.width, imgObj.height);
        };

        hudCarCount.textContent = data.car_count || 0;
        hudPlateCount.textContent = data.plate_count || 0;

        if (data.car_count > 0 || data.plate_count > 0) {
            hudTargetBadge.innerHTML = `<i class="fa-solid fa-bullseye"></i> DETECTED (${data.car_count} CARS, ${data.plate_count} PLATES)`;
            hudTargetBadge.style.borderColor = '#00f2fe';
        } else {
            hudTargetBadge.innerHTML = '<i class="fa-solid fa-eye-slash"></i> NO VEHICLES FOUND IN PHOTO';
        }

        if (data.captured) {
            triggerCaptureEffects();
            addSnapshotCard(data.captured, true);
        }
    })
    .catch(err => {
        console.error("Image upload error:", err);
        alert("Failed to process uploaded image.");
    });
}

// SAMPLE VIDEO LOADING
function loadSampleVideo() {
    fetch('/api/sample_video')
        .then(res => res.json())
        .then(data => {
            if (data.available) {
                videoElement.src = data.video_url;
                videoElement.load();
                lblPlayPause.textContent = 'Play';
                btnPlayPause.querySelector('i').className = 'fa-solid fa-play';
                isPlaying = false;
                startDetectionLoop();
            } else {
                alert("Sample video not found on server.");
            }
        })
        .catch(err => console.error("Error loading sample video:", err));
}

// VIDEO PLAY / PAUSE CONTROLS
function togglePlayPause() {
    if (currentMode !== 'video') return;

    if (videoElement.paused) {
        videoElement.play();
        isPlaying = true;
        lblPlayPause.textContent = 'Pause';
        btnPlayPause.querySelector('i').className = 'fa-solid fa-pause';
        startDetectionLoop();
    } else {
        pauseVideo();
    }
}

function pauseVideo() {
    videoElement.pause();
    isPlaying = false;
    lblPlayPause.textContent = 'Play';
    btnPlayPause.querySelector('i').className = 'fa-solid fa-play';
}

// WEBCAM LIVE FOOTAGE CONTROLS
async function startWebcam() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' }
        });
        webcamStream = stream;
        videoElement.srcObject = stream;
        await videoElement.play();
        
        isWebcamActive = true;
        btnStartWebcam.disabled = true;
        btnStopWebcam.disabled = false;
        hudTargetBadge.innerHTML = '<i class="fa-solid fa-crosshairs"></i> LIVE CAM ACTIVE';
        startDetectionLoop();
    } catch (err) {
        console.error("Webcam Access Error:", err);
        alert("Could not access camera. Please allow camera permissions in browser.");
    }
}

function stopWebcam() {
    if (webcamStream) {
        webcamStream.getTracks().forEach(track => track.stop());
        webcamStream = null;
    }
    videoElement.srcObject = null;
    isWebcamActive = false;
    btnStartWebcam.disabled = false;
    btnStopWebcam.disabled = true;
    hudTargetBadge.innerHTML = '<i class="fa-solid fa-video-slash"></i> CAMERA STOPPED';
    stopDetectionLoop();
    clearOverlay();
}

// VIDEO FILE UPLOAD HANDLING
function handleVideoUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    hudTargetBadge.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> UPLOADING VIDEO...';

    fetch('/api/upload_video', {
        method: 'POST',
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            videoElement.src = data.video_url;
            videoElement.load();
            videoElement.play();
            isPlaying = true;
            lblPlayPause.textContent = 'Pause';
            btnPlayPause.querySelector('i').className = 'fa-solid fa-pause';
            hudTargetBadge.innerHTML = `<i class="fa-solid fa-check"></i> LOADED: ${file.name}`;
            startDetectionLoop();
        } else {
            alert("Upload failed: " + data.error);
        }
    })
    .catch(err => {
        console.error("Upload error:", err);
        alert("Failed to upload video.");
    });
}

let isLoopRunning = false;

// DETECTION LOOP MANAGEMENT (Non-stacking Async Loop)
function startDetectionLoop() {
    if (isLoopRunning) return;
    isLoopRunning = true;
    runDetectionCycle();
}

function stopDetectionLoop() {
    isLoopRunning = false;
}

async function runDetectionCycle() {
    if (!isLoopRunning) return;
    
    await processCurrentFrame();
    
    if (isLoopRunning) {
        // Small delay between frames for optimal responsiveness (approx 15-20 FPS)
        setTimeout(runDetectionCycle, 60);
    }
}

// FRAME PROCESSING & API CALL
async function processCurrentFrame() {
    if (isProcessing) return;
    if (videoElement.paused && !isWebcamActive && videoElement.currentTime > 0 && !isPlaying) {
        clearOverlay();
        return;
    }
    if (videoElement.readyState < 2 || !videoElement.videoWidth) return;

    isProcessing = true;

    // Sync overlay canvas size to displayed video bounding box
    const rect = videoElement.getBoundingClientRect();
    if (overlayCanvas.width !== Math.floor(rect.width) || overlayCanvas.height !== Math.floor(rect.height)) {
        overlayCanvas.width = Math.floor(rect.width);
        overlayCanvas.height = Math.floor(rect.height);
    }

    // Capture frame to canvas buffer
    const bufCanvas = webcamBufferCanvas;
    bufCanvas.width = videoElement.videoWidth;
    bufCanvas.height = videoElement.videoHeight;
    const ctx = bufCanvas.getContext('2d');
    ctx.drawImage(videoElement, 0, 0, bufCanvas.width, bufCanvas.height);

    const imageB64 = bufCanvas.toDataURL('image/jpeg', 0.75);

    try {
        const response = await fetch('/api/detect_frame', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                image: imageB64,
                conf: confThreshold,
                auto_capture: autoCapture
            })
        });

        const data = await response.json();

        if (data.detections) {
            drawOverlay(data.detections, bufCanvas.width, bufCanvas.height);
            hudCarCount.textContent = data.car_count || 0;
            hudPlateCount.textContent = data.plate_count || 0;

            if (data.car_count > 0 || data.plate_count > 0) {
                hudTargetBadge.innerHTML = `<i class="fa-solid fa-bullseye"></i> TARGET LOCKED (${data.car_count} CARS, ${data.plate_count} PLATES)`;
                hudTargetBadge.style.borderColor = '#00f2fe';
            } else {
                hudTargetBadge.innerHTML = '<i class="fa-solid fa-crosshairs"></i> SCANNING ROADWAY...';
                hudTargetBadge.style.borderColor = 'rgba(0,242,254,0.4)';
            }
        }

        // If a new snapshot was auto-captured by backend
        if (data.captured) {
            triggerCaptureEffects();
            addSnapshotCard(data.captured, true);
        }

        updateFPS();
    } catch (err) {
        console.error("Frame processing error:", err);
    } finally {
        isProcessing = false;
    }
}

// DRAW NEON BOUNDING BOX OVERLAYS ON HTML5 CANVAS
function drawOverlay(detections, sourceW, sourceH) {
    const canvasW = overlayCanvas.width;
    const canvasH = overlayCanvas.height;
    
    // Always clear previous frame overlay completely
    overlayCtx.clearRect(0, 0, canvasW, canvasH);

    if (!detections || detections.length === 0) return;

    const scaleX = canvasW / sourceW;
    const scaleY = canvasH / sourceH;

    detections.forEach(det => {
        const [x1, y1, x2, y2] = det.bbox;
        const bx = x1 * scaleX;
        const by = y1 * scaleY;
        const bw = (x2 - x1) * scaleX;
        const bh = (y2 - y1) * scaleY;

        const isCar = det.class_name === 'car' || det.class_id === 0;
        const color = isCar ? '#00f2fe' : '#00e676';
        const label = isCar ? `CAR ${Math.round(det.confidence * 100)}%` : `PLATE ${Math.round(det.confidence * 100)}%`;

        // Bounding Box Glow & Stroke
        overlayCtx.shadowColor = color;
        overlayCtx.shadowBlur = 8;
        overlayCtx.strokeStyle = color;
        overlayCtx.lineWidth = 2.5;
        overlayCtx.strokeRect(bx, by, bw, bh);

        // Corner Accents
        const cLen = Math.min(14, bw / 4, bh / 4);
        overlayCtx.lineWidth = 3.5;
        overlayCtx.shadowBlur = 0;

        // Top-left corner
        overlayCtx.beginPath(); overlayCtx.moveTo(bx, by + cLen); overlayCtx.lineTo(bx, by); overlayCtx.lineTo(bx + cLen, by); overlayCtx.stroke();
        // Top-right corner
        overlayCtx.beginPath(); overlayCtx.moveTo(bx + bw - cLen, by); overlayCtx.lineTo(bx + bw, by); overlayCtx.lineTo(bx + bw, by + cLen); overlayCtx.stroke();
        // Bottom-left corner
        overlayCtx.beginPath(); overlayCtx.moveTo(bx, by + bh - cLen); overlayCtx.lineTo(bx, by + bh); overlayCtx.lineTo(bx + cLen, by + bh); overlayCtx.stroke();
        // Bottom-right corner
        overlayCtx.beginPath(); overlayCtx.moveTo(bx + bw - cLen, by + bh); overlayCtx.lineTo(bx + bw, by + bh); overlayCtx.lineTo(bx + bw, by + bh - cLen); overlayCtx.stroke();

        // Label Tag Box
        overlayCtx.font = 'bold 11px "JetBrains Mono", monospace';
        const textWidth = overlayCtx.measureText(label).width;
        const tagH = 18;

        const tagY = (by - tagH < 0) ? by + 2 : by - tagH;

        overlayCtx.fillStyle = color;
        overlayCtx.fillRect(bx, tagY, textWidth + 10, tagH);

        overlayCtx.fillStyle = '#050b14';
        overlayCtx.fillText(label, bx + 5, tagY + 13);
    });
}

function clearOverlay() {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

// FPS COUNTER
function updateFPS() {
    frameCount++;
    const now = performance.now();
    if (now - lastFpsTime >= 1000) {
        currentFps = frameCount;
        frameCount = 0;
        lastFpsTime = now;
        fpsCounter.textContent = `${String(currentFps).padStart(2, '0')} FPS`;
    }
}

// AUTO-CAPTURE VISUAL & AUDIO FLASH EFFECTS
function triggerCaptureEffects() {
    captureFlashNotice.style.display = 'inline-flex';
    setTimeout(() => {
        captureFlashNotice.style.display = 'none';
    }, 1800);

    // Audio beep pulse using Web Audio API
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, audioCtx.currentTime); // A5 note
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.15);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.15);
    } catch (e) {
        // Ignore audio restrictions
    }
}

// MANUAL CAPTURE TRIGGER
function triggerManualCapture() {
    processCurrentFrame();
}

// SETTINGS UPDATERS
function updateConfSlider(val) {
    confThreshold = val / 100;
    document.getElementById('confValue').textContent = `${val}%`;
}

document.getElementById('autoCaptureToggle').addEventListener('change', (e) => {
    autoCapture = e.target.checked;
});

// SNAPSHOT GALLERY MANAGEMENT
function fetchSnapshots() {
    fetch('/api/snapshots')
        .then(res => res.json())
        .then(snapshots => {
            renderGallery(snapshots);
        })
        .catch(err => console.error("Error fetching snapshots:", err));
}

function renderGallery(snapshots) {
    const emptyState = document.getElementById('emptyState');
    if (!snapshots || snapshots.length === 0) {
        emptyState.style.display = 'flex';
        galleryContainer.innerHTML = '';
        galleryContainer.appendChild(emptyState);
        galleryCountBadge.textContent = '0 Captured';
        return;
    }

    emptyState.style.display = 'none';
    galleryContainer.innerHTML = '';
    galleryCountBadge.textContent = `${snapshots.length} Captured`;

    snapshots.forEach(snap => {
        addSnapshotCard(snap, false);
    });
}

function addSnapshotCard(snap, isNew = true) {
    const emptyState = document.getElementById('emptyState');
    if (emptyState) emptyState.style.display = 'none';

    // Avoid duplicate cards
    const existing = document.getElementById(`card_${snap.id}`);
    if (existing) {
        // Update plate text if changed
        const badge = existing.querySelector('.plate-badge');
        if (badge) badge.textContent = snap.plate_text || 'AUTO DETECTED';
        return;
    }

    const card = document.createElement('div');
    card.className = 'captured-card';
    card.id = `card_${snap.id}`;

    const plateText = snap.plate_text || 'AUTO DETECTED';

    card.innerHTML = `
        <div class="captured-thumbs" onclick='openModal(${JSON.stringify(snap)})' style="cursor: pointer;" title="Click to View Snapshot Details">
            <div class="thumb-box">
                <img src="${snap.car_image}" alt="Car Snapshot" loading="lazy">
                <span class="thumb-tag">CAR ${snap.car_confidence}%</span>
            </div>
            <div class="thumb-box">
                <img src="${snap.plate_image}" alt="Plate Crop" loading="lazy">
                <span class="thumb-tag emerald">PLATE ${snap.plate_confidence}%</span>
            </div>
        </div>
        <div class="captured-info">
            <span class="plate-badge">${plateText}</span>
            <div class="card-actions">
                <button class="btn-card-view" onclick='openModal(${JSON.stringify(snap)})' title="View Snapshot">
                    <i class="fa-solid fa-expand"></i>
                </button>
                <button class="btn-card-delete" onclick="deleteSingleSnapshot('${snap.id}')" title="Delete Snapshot">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        </div>
    `;

    if (isNew && galleryContainer.firstChild) {
        galleryContainer.insertBefore(card, galleryContainer.firstChild);
    } else {
        galleryContainer.appendChild(card);
    }

    const currentCount = galleryContainer.querySelectorAll('.captured-card').length;
    galleryCountBadge.textContent = `${currentCount} Captured`;
}

function deleteSingleSnapshot(snapId) {
    const card = document.getElementById(`card_${snapId}`);
    if (!card) return;

    card.style.opacity = '0.4';

    fetch(`/api/snapshots/delete/${snapId}`, { method: 'DELETE' })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'deleted') {
                card.style.transform = 'scale(0.8)';
                card.style.transition = 'all 0.3s ease';
                setTimeout(() => {
                    card.remove();
                    const remaining = galleryContainer.querySelectorAll('.captured-card').length;
                    galleryCountBadge.textContent = `${remaining} Captured`;
                    if (remaining === 0) {
                        const emptyState = document.getElementById('emptyState');
                        if (emptyState) emptyState.style.display = 'flex';
                    }
                }, 300);
            }
        })
        .catch(err => console.error("Error deleting snapshot:", err));
}

function clearAllSnapshots() {
    if (!confirm("Are you sure you want to clear all captured snapshots?")) return;

    fetch('/api/snapshots/clear', { method: 'POST' })
        .then(res => res.json())
        .then(() => {
            fetchSnapshots();
        });
}

// SNAPSHOT MODAL VIEW
function openModal(snap) {
    document.getElementById('modalCarImg').src = snap.car_image;
    document.getElementById('modalPlateImg').src = snap.plate_image;
    document.getElementById('modalPlateText').textContent = snap.plate_text || 'AUTO DETECTED';
    document.getElementById('modalTimestamp').textContent = snap.timestamp;
    document.getElementById('modalCarConf').textContent = snap.car_confidence;
    document.getElementById('modalPlateConf').textContent = snap.plate_confidence;

    document.getElementById('modalDownloadCar').href = snap.car_image;
    document.getElementById('modalDownloadPlate').href = snap.plate_image;

    document.getElementById('snapshotModal').style.display = 'flex';
}

function closeModal(event) {
    if (!event || event.target.id === 'snapshotModal' || event.target.closest('.modal-close-btn')) {
        document.getElementById('snapshotModal').style.display = 'none';
    }
}
