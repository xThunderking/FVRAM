// --- 1. DATOS Y LÓGICA CORE ---
let reports = JSON.parse(localStorage.getItem('ram_reports'));

if (!Array.isArray(reports)) {
    reports = [];
    saveData();
}

const LEGACY_DEMO_REPORT_ID = '0126-001';

function removeLegacyDemoReport() {
    const before = reports.length;
    reports = reports.filter(r => !(r && r.id === LEGACY_DEMO_REPORT_ID));
    if (reports.length !== before) {
        saveData();
    }
}

removeLegacyDemoReport();

let currentEditingId = null;
let isAdminLoggedIn = false;
let isSubmitting = false;
const ADMIN_PASSWORD = 'Farma2026';
let adminAccessToken = false;

function saveData() {
    localStorage.setItem('ram_reports', JSON.stringify(reports));
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeWhitespace(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function sanitizeText(value) {
    return normalizeWhitespace(value).replace(/[<>]/g, '');
}

function parseISODate(value) {
    if (!value) return null;
    const dt = new Date(`${value}T00:00:00`);
    return Number.isNaN(dt.getTime()) ? null : dt;
}

function isValidName(value) {
    return /^[A-Za-zÁÉÍÓÚáéíóúÑñÜü'.,\-\s]+$/.test(value);
}

function isValidRoom(value) {
    return /^[A-Za-z0-9\-\/]{1,20}$/.test(value);
}

function setFieldState(field, status) {
    if (!field) return;
    field.classList.remove('input-error', 'input-ok');
    if (status === 'error') field.classList.add('input-error');
    if (status === 'ok') field.classList.add('input-ok');
}

function clearFieldStates() {
    document.querySelectorAll('#ram-form input, #ram-form select, #ram-form textarea').forEach(el => {
        setFieldState(el, 'none');
    });
}

function showFormFeedback(type, message) {
    const feedback = document.getElementById('form-feedback');
    if (!feedback) return;
    feedback.classList.remove('hidden', 'feedback-error', 'feedback-success');
    feedback.classList.add(type === 'error' ? 'feedback-error' : 'feedback-success');
    feedback.textContent = message;
}

function hideFormFeedback() {
    const feedback = document.getElementById('form-feedback');
    if (!feedback) return;
    feedback.classList.add('hidden');
    feedback.textContent = '';
    feedback.classList.remove('feedback-error', 'feedback-success');
}

function updateDescriptionCounter() {
    const description = document.getElementById('description');
    const counter = document.getElementById('descriptionCounter');
    if (!description || !counter) return;
    counter.textContent = `${description.value.length} / 1200`;
}

function setSubmitState(loading) {
    const btn = document.getElementById('submit-btn');
    if (!btn) return;
    btn.disabled = loading;
}

function buildReportPayload() {
    let pos = document.getElementById('reporterPosition').value;
    if (pos === 'Otro') pos = document.getElementById('otherPosition').value;

    return {
        id: generateId(),
        patientName: sanitizeText(document.getElementById('patientName').value),
        dob: document.getElementById('dob').value,
        room: sanitizeText(document.getElementById('room').value).toUpperCase(),
        drug: sanitizeText(document.getElementById('drug').value),
        reactionDate: document.getElementById('reactionDate').value,
        reactionTime: document.getElementById('reactionTime').value,
        description: sanitizeText(document.getElementById('description').value),
        reporterName: sanitizeText(document.getElementById('reporterName').value),
        reporterPosition: sanitizeText(pos),
        timestamp: new Date().toISOString(),
        status: 'Pendiente',
        service: '',
        analysis: '',
        rejectionReason: ''
    };
}

function validateReportPayload(payload) {
    const issues = [];
    const now = new Date();
    const patientNameField = document.getElementById('patientName');
    const dobField = document.getElementById('dob');
    const roomField = document.getElementById('room');
    const drugField = document.getElementById('drug');
    const reactionDateField = document.getElementById('reactionDate');
    const reactionTimeField = document.getElementById('reactionTime');
    const descriptionField = document.getElementById('description');
    const reporterNameField = document.getElementById('reporterName');
    const positionField = document.getElementById('reporterPosition');
    const otherPositionField = document.getElementById('otherPosition');

    clearFieldStates();

    if (!payload.patientName || payload.patientName.length < 5 || !isValidName(payload.patientName)) {
        issues.push({ field: patientNameField, message: 'Nombre de paciente inválido.' });
    }

    if (!payload.reporterName || payload.reporterName.length < 5 || !isValidName(payload.reporterName)) {
        issues.push({ field: reporterNameField, message: 'Nombre del notificador inválido.' });
    }

    if (!payload.room || !isValidRoom(payload.room)) {
        issues.push({ field: roomField, message: 'Habitación inválida (usa letras/números, - o /).' });
    }

    if (!payload.drug || payload.drug.length < 2) {
        issues.push({ field: drugField, message: 'Medicamento sospechoso inválido.' });
    }

    if (!payload.description || payload.description.length < 20) {
        issues.push({ field: descriptionField, message: 'La descripción debe tener al menos 20 caracteres.' });
    }

    const dob = parseISODate(payload.dob);
    const reactionDate = parseISODate(payload.reactionDate);
    if (!dob || dob > now) {
        issues.push({ field: dobField, message: 'Fecha de nacimiento inválida.' });
    }

    if (!reactionDate || reactionDate > now) {
        issues.push({ field: reactionDateField, message: 'La fecha de reacción no puede ser futura.' });
    }

    if (dob && reactionDate && reactionDate < dob) {
        issues.push({ field: reactionDateField, message: 'La reacción no puede ocurrir antes del nacimiento.' });
    }

    if (!payload.reactionTime) {
        issues.push({ field: reactionTimeField, message: 'La hora de reacción es obligatoria.' });
    }

    if (!payload.reporterPosition || payload.reporterPosition.length < 3) {
        issues.push({ field: positionField, message: 'Selecciona o especifica un puesto válido.' });
    }

    if (positionField.value === 'Otro' && payload.reporterPosition.length < 3) {
        issues.push({ field: otherPositionField, message: 'Especifica el puesto en al menos 3 caracteres.' });
    }

    const issueFields = new Set(issues.map(i => i.field));
    issueFields.forEach(field => setFieldState(field, 'error'));

    if (issues.length === 0) {
        [patientNameField, dobField, roomField, drugField, reactionDateField, reactionTimeField, descriptionField, reporterNameField, positionField]
            .forEach(field => setFieldState(field, 'ok'));
    }

    return issues;
}

function initFormEnhancements() {
    const today = new Date().toISOString().split('T')[0];
    const dob = document.getElementById('dob');
    const reactionDate = document.getElementById('reactionDate');
    const description = document.getElementById('description');

    if (dob) dob.max = today;
    if (reactionDate) reactionDate.max = today;
    if (description) {
        description.addEventListener('input', updateDescriptionCounter);
    }

    ['patientName', 'drug', 'description', 'reporterName', 'otherPosition'].forEach(id => {
        const field = document.getElementById(id);
        if (!field) return;
        field.addEventListener('blur', () => {
            field.value = sanitizeText(field.value);
            updateDescriptionCounter();
        });
    });

    const room = document.getElementById('room');
    if (room) {
        room.addEventListener('input', () => {
            room.value = room.value.replace(/[^A-Za-z0-9\-\/]/g, '').toUpperCase();
        });
    }

    updateDescriptionCounter();
}

function updateLastUpdateLabel() {
    const el = document.getElementById('admin-last-update');
    if (!el) return;
    el.textContent = `Última actualización: ${new Date().toLocaleString('es-MX')}`;
}

function renderAdminStats() {
    const total = reports.length;
    const pending = reports.filter(r => r.status === 'Pendiente').length;
    const published = reports.filter(r => r.status === 'Publicado').length;
    const rejected = reports.filter(r => r.status === 'Rechazado').length;

    const totalEl = document.getElementById('admin-stat-total');
    const pendingEl = document.getElementById('admin-stat-pending');
    const publishedEl = document.getElementById('admin-stat-published');
    const rejectedEl = document.getElementById('admin-stat-rejected');

    if (totalEl) totalEl.textContent = String(total);
    if (pendingEl) pendingEl.textContent = String(pending);
    if (publishedEl) publishedEl.textContent = String(published);
    if (rejectedEl) rejectedEl.textContent = String(rejected);
}

function getTopByField(items, field) {
    if (!items.length) return '--';
    const countMap = items.reduce((acc, item) => {
        const key = item[field] || 'No asignado';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});

    const sorted = Object.entries(countMap).sort((a, b) => b[1] - a[1]);
    return sorted.length ? `${sorted[0][0]} (${sorted[0][1]})` : '--';
}

function renderBoardStats(items) {
    const totalEl = document.getElementById('board-stat-total');
    const topServiceEl = document.getElementById('board-stat-top-service');
    const topDrugEl = document.getElementById('board-stat-top-drug');

    if (totalEl) totalEl.textContent = String(items.length);
    if (topServiceEl) topServiceEl.textContent = getTopByField(items, 'service');
    if (topDrugEl) topDrugEl.textContent = getTopByField(items, 'drug');
}

function exportReportsJson() {
    const safeData = reports.map(r => ({
        ...r,
        patientName: sanitizeText(r.patientName),
        room: sanitizeText(r.room),
        drug: sanitizeText(r.drug),
        description: sanitizeText(r.description),
        reporterName: sanitizeText(r.reporterName),
        reporterPosition: sanitizeText(r.reporterPosition),
        analysis: sanitizeText(r.analysis),
        rejectionReason: sanitizeText(r.rejectionReason)
    }));
    const blob = new Blob([JSON.stringify(safeData, null, 2)], { type: 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `reportes-ram-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
}

// --- 2. GENERADOR DE FOLIOS ---
function generateId() {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');

    const currentYearReports = reports.filter(r => r.id && r.id.substring(2, 4) === yy);
    let maxCount = 0;
    currentYearReports.forEach(r => {
        const parts = r.id.split('-');
        if (parts.length === 2) {
            const count = parseInt(parts[1], 10);
            if (!isNaN(count) && count > maxCount) maxCount = count;
        }
    });
    const nextCount = String(maxCount + 1).padStart(3, '0');
    return `${mm}${yy}-${nextCount}`;
}

// --- 3. ABREVIATURA DE NOMBRES (Apellidos primero) ---
function abbreviateName(fullName) {
    const parts = fullName.trim().split(/\s+/);
    if (parts.length <= 1) return parts[0]?.charAt(0).toUpperCase() + '.' || '';

    let firstNames = [];
    let lastNames = [];
    if (parts.length === 2) {
        firstNames = [parts[0]];
        lastNames = [parts[1]];
    } else if (parts.length === 3) {
        firstNames = [parts[0]];
        lastNames = [parts[1], parts[2]];
    } else {
        lastNames = parts.slice(-2);
        firstNames = parts.slice(0, -2);
    }

    const initials = [...lastNames, ...firstNames].map(w => w.charAt(0).toUpperCase() + '.');
    return initials.join(' ');
}

// --- 4. NAVEGACIÓN Y SEGURIDAD SIMULADA ---
function navigate(viewId) {
    if (viewId === 'admin') {
        if (!adminAccessToken) {
            checkAdmin();
            return;
        }
        adminAccessToken = false;
    }

    document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
    document.getElementById(`view-${viewId}`).classList.remove('hidden');

    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.toggle('bg-blue-900', btn.dataset.target === viewId);
        btn.classList.toggle('bg-blue-800', btn.dataset.target !== viewId);
    });

    if (viewId === 'admin') loadAdminTable();
    if (viewId === 'board') loadPublicBoard();
}

function checkAdmin() {
    const pass = prompt('Acceso restringido. Ingrese la clave:');
    if (pass === null) return;

    if (pass === ADMIN_PASSWORD) {
        isAdminLoggedIn = true;
        adminAccessToken = true;
        navigate('admin');
    } else {
        alert('Clave incorrecta.');
    }
}

function setupAdminAccessTrigger() {
    const trigger = document.getElementById('admin-trigger-icon');
    if (!trigger) return;

    let clickCount = 0;
    let resetTimer = null;
    const resetWindowMs = 900;

    const registerClick = () => {
        clickCount += 1;

        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
            clickCount = 0;
        }, resetWindowMs);

        if (clickCount >= 3) {
            clickCount = 0;
            if (resetTimer) clearTimeout(resetTimer);
            checkAdmin();
        }
    };

    trigger.addEventListener('click', registerClick);
    trigger.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            registerClick();
        }
    });
}

function logoutAdmin() {
    isAdminLoggedIn = false;
    navigate('report');
}

// --- 5. LÓGICA DE INTERFAZ DEL REPORTE ---
function toggleOtherPosition() {
    const select = document.getElementById('reporterPosition');
    const otherInput = document.getElementById('otherPosition');
    if (select.value === 'Otro') {
        otherInput.classList.remove('hidden');
        otherInput.required = true;
    } else {
        otherInput.classList.add('hidden');
        otherInput.required = false;
    }
}

function submitReport(e) {
    e.preventDefault();

    if (isSubmitting) return;
    hideFormFeedback();
    const newReport = buildReportPayload();
    const issues = validateReportPayload(newReport);
    if (issues.length > 0) {
        showFormFeedback('error', issues[0].message);
        if (issues[0].field) issues[0].field.focus();
        return;
    }

    isSubmitting = true;
    setSubmitState(true);

    reports.push(newReport);
    saveData();
    e.target.reset();
    toggleOtherPosition();
    clearFieldStates();
    updateDescriptionCounter();
    showFormFeedback('success', `Reporte enviado correctamente. Folio asignado: ${newReport.id}`);

    isSubmitting = false;
    setSubmitState(false);
}

// --- 6. GESTIÓN ADMIN ---
function loadAdminTable() {
    const tbody = document.getElementById('admin-table-body');
    const searchTerm = document.getElementById('adminSearch').value.toLowerCase();
    const statusFilter = document.getElementById('adminStatusFilter').value;
    tbody.innerHTML = '';

    renderAdminStats();
    updateLastUpdateLabel();

    const filtered = reports.filter(r => {
        const matchesSearch = r.id.toLowerCase().includes(searchTerm) ||
            r.patientName.toLowerCase().includes(searchTerm) ||
            r.drug.toLowerCase().includes(searchTerm);
        const matchesStatus = statusFilter === 'Todos' || r.status === statusFilter;
        return matchesSearch && matchesStatus;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-6 py-10 text-center text-slate-500">No hay reportes que coincidan con los filtros.</td></tr>';
        return;
    }

    filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).forEach(r => {
        const tr = document.createElement('tr');
        let statusBadge = 'bg-yellow-100 text-yellow-800';
        if (r.status === 'Publicado') statusBadge = 'bg-green-100 text-green-800';
        if (r.status === 'Rechazado') statusBadge = 'bg-red-100 text-red-800';

        tr.innerHTML = `
            <td class="px-6 py-4 whitespace-nowrap">
                <div class="font-bold text-gray-900">${escapeHtml(r.id)}</div>
                <div class="text-xs text-gray-500">${escapeHtml(new Date(r.timestamp).toLocaleDateString())}</div>
            </td>
            <td class="px-6 py-4 whitespace-nowrap">
                <div class="text-sm text-gray-900">${escapeHtml(r.patientName)}</div>
                <div class="text-xs text-gray-500">Hab: ${escapeHtml(r.room)}</div>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-semibold">${escapeHtml(r.drug)}</td>
            <td class="px-6 py-4 whitespace-nowrap">
                <span class="px-2 inline-flex text-xs leading-5 font-bold rounded-full ${statusBadge}">${escapeHtml(r.status)}</span>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium">
                <button onclick="openModal('${escapeHtml(r.id)}')" class="bg-gray-100 text-blue-700 hover:bg-blue-100 px-3 py-1 rounded transition"><i class="fas fa-edit mr-1"></i> Dictaminar</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function toggleRejectionReason() {
    const status = document.getElementById('admin-status').value;
    const container = document.getElementById('rejection-container');
    if (status === 'Rechazado') {
        container.classList.remove('hidden');
    } else {
        container.classList.add('hidden');
    }
}

function openModal(id) {
    const r = reports.find(x => x.id === id);
    if (!r) return;
    currentEditingId = id;

    document.getElementById('p-id').innerText = r.id;
    document.getElementById('p-name').innerText = r.patientName;
    document.getElementById('p-dob').innerText = r.dob;
    document.getElementById('p-room').innerText = r.room;
    document.getElementById('p-drug').innerText = r.drug;
    document.getElementById('p-datetime').innerText = `${r.reactionDate} ${r.reactionTime}`;
    document.getElementById('p-reporter').innerText = r.reporterName;
    document.getElementById('p-position').innerText = r.reporterPosition;
    document.getElementById('p-submission-time').innerText = new Date(r.timestamp).toLocaleString('es-MX');
    document.getElementById('p-desc').innerText = r.description;
    document.getElementById('p-print-date').innerText = new Date().toLocaleString('es-MX');

    document.getElementById('admin-status').value = r.status || 'Pendiente';
    document.getElementById('admin-service').value = r.service || '';
    document.getElementById('admin-analysis').value = r.analysis || '';
    document.getElementById('admin-rejection').value = r.rejectionReason || '';

    toggleRejectionReason();
    document.getElementById('admin-modal').classList.remove('hidden');
}

function closeModal() {
    document.getElementById('admin-modal').classList.add('hidden');
    currentEditingId = null;
}

function saveAdminAnalysis() {
    const index = reports.findIndex(x => x.id === currentEditingId);
    if (index > -1) {
        const status = document.getElementById('admin-status').value;
        const service = sanitizeText(document.getElementById('admin-service').value);
        const analysis = sanitizeText(document.getElementById('admin-analysis').value);
        const rejectionReason = sanitizeText(document.getElementById('admin-rejection').value);

        if (status === 'Publicado' && !service) {
            alert('Para publicar, debes asignar un servicio.');
            return;
        }
        if (status === 'Rechazado' && rejectionReason.length < 8) {
            alert('Para rechazar, captura un motivo de al menos 8 caracteres.');
            return;
        }

        reports[index].status = status;
        reports[index].service = service;
        reports[index].analysis = analysis;
        reports[index].rejectionReason = rejectionReason;

        saveData();
        closeModal();
        loadAdminTable();
        if (status === 'Publicado') loadPublicBoard();
    }
}

// --- 7. TABLERO PUBLICO ---
function loadPublicBoard() {
    const container = document.getElementById('board-container');
    const search = document.getElementById('boardSearch').value.toLowerCase();
    const serviceFilter = document.getElementById('boardServiceFilter').value;
    const sortBy = document.getElementById('boardSort')?.value || 'recent';
    container.innerHTML = '';

    const published = reports.filter(r => {
        const isPublished = r.status === 'Publicado';
        const matchesSearch = r.drug.toLowerCase().includes(search) || r.analysis.toLowerCase().includes(search);
        const matchesService = serviceFilter === '' || r.service === serviceFilter;
        return isPublished && matchesSearch && matchesService;
    });

    if (sortBy === 'oldest') {
        published.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    } else if (sortBy === 'drug-az') {
        published.sort((a, b) => a.drug.localeCompare(b.drug, 'es-MX'));
    } else {
        published.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    renderBoardStats(published);

    if (published.length === 0) {
        container.innerHTML = '<div class="col-span-full text-center py-12 text-gray-400 bg-gray-50 rounded border border-dashed"><i class="fas fa-filter text-3xl mb-3"></i><br>No hay reportes publicados que coincidan con la búsqueda.</div>';
        return;
    }

    published.forEach(r => {
        const card = document.createElement('div');
        card.className = 'board-card bg-white border rounded-xl shadow-sm hover:shadow-md transition overflow-hidden border-l-4 border-l-blue-600 flex flex-col';

        card.innerHTML = `
            <div class="p-5 flex-grow">
                <div class="flex justify-between items-start mb-3">
                    <span class="bg-blue-100 text-blue-900 text-xs px-2 py-1 rounded font-bold uppercase tracking-wider">${escapeHtml(r.service || 'Servicio no asignado')}</span>
                    <span class="text-xs text-gray-500 font-mono">${escapeHtml(r.id)}</span>
                </div>
                <p class="text-xs text-slate-500 mb-2"><i class="fas fa-calendar-day mr-1"></i>${escapeHtml(new Date(r.timestamp).toLocaleString('es-MX'))}</p>
                <h3 class="font-bold text-lg text-gray-800 mb-1">Sospecha: <span class="text-red-700">${escapeHtml(r.drug)}</span></h3>
                <p class="text-sm text-gray-500 mb-4 font-mono bg-gray-100 inline-block px-2 py-1 rounded"><i class="fas fa-user-secret mr-1"></i> Paciente: ${escapeHtml(abbreviateName(r.patientName))}</p>

                <div class="bg-gray-50 p-3 rounded text-sm text-gray-700 italic border-l-2 border-gray-300 mb-4 line-clamp-3 hover:line-clamp-none transition-all">
                    "${escapeHtml(r.description)}"
                </div>

                <div class="mt-auto">
                    <h4 class="text-sm font-bold text-blue-900 mb-2 border-b pb-1"><i class="fas fa-lightbulb text-yellow-500 mr-1"></i> Análisis / Dictamen</h4>
                    <p class="text-sm text-gray-800 whitespace-pre-wrap">${escapeHtml(r.analysis || 'Sin análisis detallado.')}</p>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

initFormEnhancements();
setupAdminAccessTrigger();
navigate('report');
