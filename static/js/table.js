/* ==========================================================================
   AUTOVISION AI - RECORDS TABLE MANAGEMENT JAVASCRIPT
   ========================================================================== */

let allSnapshots = [];
let selectedIds = new Set();

document.addEventListener('DOMContentLoaded', () => {
    fetchTableSnapshots();
});

function fetchTableSnapshots() {
    fetch('/api/snapshots')
        .then(res => res.json())
        .then(snapshots => {
            allSnapshots = snapshots || [];
            renderTableRows(allSnapshots);
        })
        .catch(err => console.error("Error fetching table snapshots:", err));
}

function renderTableRows(snapshots) {
    const tbody = document.getElementById('tableBody');
    const emptyState = document.getElementById('emptyTableState');
    const countBadge = document.getElementById('totalRecordsBadge');

    countBadge.textContent = `${snapshots.length} Records`;

    if (!snapshots || snapshots.length === 0) {
        tbody.innerHTML = '';
        emptyState.style.display = 'flex';
        return;
    }

    emptyState.style.display = 'none';
    tbody.innerHTML = '';

    snapshots.forEach(snap => {
        const tr = document.createElement('tr');
        tr.id = `row_${snap.id}`;

        const isChecked = selectedIds.has(snap.id);
        const plateText = snap.plate_text || 'AUTO DETECTED';

        tr.innerHTML = `
            <td>
                <input type="checkbox" class="row-checkbox" value="${snap.id}" ${isChecked ? 'checked' : ''} onchange="toggleRowSelect('${snap.id}', this.checked)">
            </td>
            <td>
                <div class="table-thumb-box" onclick='openModal(${JSON.stringify(snap)})'>
                    <img src="${snap.car_image}" alt="Car" loading="lazy">
                </div>
            </td>
            <td>
                <div class="table-thumb-box" onclick='openModal(${JSON.stringify(snap)})'>
                    <img src="${snap.plate_image}" alt="Plate" loading="lazy">
                </div>
            </td>
            <td>
                <span class="table-plate-badge">${plateText}</span>
            </td>
            <td>
                <div class="table-conf-stack">
                    <span class="conf-pill cyan">Car: ${snap.car_confidence}%</span>
                    <span class="conf-pill emerald">Plate: ${snap.plate_confidence}%</span>
                </div>
            </td>
            <td>
                <span class="table-time-label"><i class="fa-regular fa-clock"></i> ${snap.timestamp}</span>
            </td>
            <td>
                <div class="table-action-btns">
                    <button class="btn-table-act view" onclick='openModal(${JSON.stringify(snap)})' title="View Full High-Res Snapshot">
                        <i class="fa-solid fa-expand"></i> View
                    </button>
                    <a href="${snap.car_image}" download="${snap.id}_car.jpg" class="btn-table-act car" title="Save Only Car Photo">
                        <i class="fa-solid fa-car"></i> Car
                    </a>
                    <a href="${snap.plate_image}" download="${snap.id}_plate.jpg" class="btn-table-act plate" title="Save Only Plate Crop">
                        <i class="fa-solid fa-rectangle-ad"></i> Plate
                    </a>
                    <button class="btn-table-act delete" onclick="deleteSingleRow('${snap.id}')" title="Delete Record">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });

    updateSelectionPill();
}

function filterTableRecords() {
    const query = document.getElementById('searchInput').value.toLowerCase().trim();
    if (!query) {
        renderTableRows(allSnapshots);
        return;
    }

    const filtered = allSnapshots.filter(s => 
        (s.plate_text && s.plate_text.toLowerCase().includes(query)) ||
        (s.timestamp && s.timestamp.toLowerCase().includes(query)) ||
        (s.id && s.id.toLowerCase().includes(query))
    );

    renderTableRows(filtered);
}

function toggleSelectAll(masterCb) {
    const checkboxes = document.querySelectorAll('.row-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = masterCb.checked;
        if (masterCb.checked) {
            selectedIds.add(cb.value);
        } else {
            selectedIds.delete(cb.value);
        }
    });
    updateSelectionPill();
}

function toggleRowSelect(snapId, checked) {
    if (checked) {
        selectedIds.add(snapId);
    } else {
        selectedIds.delete(snapId);
    }

    const masterCb = document.getElementById('selectAllCheckbox');
    const allCbs = document.querySelectorAll('.row-checkbox');
    masterCb.checked = allCbs.length > 0 && selectedIds.size === allCbs.length;

    updateSelectionPill();
}

function updateSelectionPill() {
    const pill = document.getElementById('selectionPill');
    pill.textContent = `${selectedIds.size} Selected`;
    if (selectedIds.size > 0) {
        pill.classList.add('active');
    } else {
        pill.classList.remove('active');
    }
}

// SAVE / EXPORT SELECTED SNAPSHOTS TO ZIP
function exportSelected(mode = 'all') {
    if (selectedIds.size === 0) {
        alert("Please select at least one record to export.");
        return;
    }

    const idList = Array.from(selectedIds);
    const params = new URLSearchParams();
    params.append('mode', mode);
    idList.forEach(id => params.append('id', id));

    window.location.href = `/api/snapshots/export_zip?${params.toString()}`;
}

// BATCH DELETE SELECTED RECORDS
function deleteSelectedRecords() {
    if (selectedIds.size === 0) {
        alert("Please select records to delete.");
        return;
    }

    if (!confirm(`Are you sure you want to delete ${selectedIds.size} selected record(s)?`)) return;

    fetch('/api/snapshots/batch_delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedIds) })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            selectedIds.clear();
            document.getElementById('selectAllCheckbox').checked = false;
            fetchTableSnapshots();
        }
    })
    .catch(err => console.error("Batch delete error:", err));
}

// SINGLE ROW DELETE
function deleteSingleRow(snapId) {
    const tr = document.getElementById(`row_${snapId}`);
    if (!tr) return;

    fetch(`/api/snapshots/delete/${snapId}`, { method: 'DELETE' })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'deleted') {
                selectedIds.delete(snapId);
                tr.style.opacity = '0.3';
                tr.style.transform = 'scaleY(0.5)';
                tr.style.transition = 'all 0.25s ease';
                setTimeout(() => {
                    tr.remove();
                    allSnapshots = allSnapshots.filter(s => s.id !== snapId);
                    document.getElementById('totalRecordsBadge').textContent = `${allSnapshots.length} Records`;
                    updateSelectionPill();
                }, 250);
            }
        });
}

function clearAllTableRecords() {
    if (!confirm("Are you sure you want to clear ALL detection records?")) return;

    fetch('/api/snapshots/clear', { method: 'POST' })
        .then(res => res.json())
        .then(() => {
            selectedIds.clear();
            fetchTableSnapshots();
        });
}

// MODAL VIEW
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
