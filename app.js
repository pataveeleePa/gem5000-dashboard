'use strict';

Chart.register(ChartDataLabels);

const CONFIG = window.GEM5000_CONFIG || {};
const screens = ['setupScreen', 'loadingScreen', 'loginScreen', 'accessDeniedScreen', 'dashboardScreen'];
const chartInstances = [];
const IMPORT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;

let supabaseClient = null;
let allRows = [];
let latestSync = null;
let importAppUrl = '';
let currentSession = null;
let currentUserRole = '';
let currentImportRequestId = '';
let importBusy = false;
let importTimeoutId = null;

const AREA_ORDER = ['ER', 'ICU4C', 'LAB', 'LABORATORY', 'NICU/PICU', 'SICU/CCU'];
const ANALYZER_ORDER = ['ANES', 'ANES0.5', 'ER support', 'GEM5000', 'NEWGEM5000', 'NEW GEM5000'];
const COLORS = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#4f46e5', '#be123c'];

function showScreen(id) {
  screens.forEach(screenId => document.getElementById(screenId)?.classList.toggle('hidden', screenId !== id));
}

function validateConfig() {
  const url = String(CONFIG.SUPABASE_URL || '');
  const key = String(CONFIG.SUPABASE_PUBLISHABLE_KEY || '');
  if (!url.startsWith('https://') || url.includes('YOUR_PROJECT_REF')) return 'SUPABASE_URL ยังไม่ได้ตั้งค่า';
  if (!key || key.includes('REPLACE_ME') || key.startsWith('sb_secret_')) return 'SUPABASE_PUBLISHABLE_KEY ยังไม่ถูกต้อง';
  return '';
}

async function init() {
  const configError = validateConfig();
  if (configError) {
    document.getElementById('setupMessage').textContent = configError + ' กรุณาแก้ github-pages/config.js';
    showScreen('setupScreen');
    return;
  }

  const { createClient } = window.supabase;
  supabaseClient = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  wireEvents();
  configureImportUi();

  const { data } = await supabaseClient.auth.getSession();
  if (data.session) await openAuthorizedSession(data.session);
  else showScreen('loginScreen');

  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    currentSession = session || null;
    if (event === 'SIGNED_OUT' || !session) {
      currentUserRole = '';
      applyImportPermission();
      showScreen('loginScreen');
    }
  });
}

function wireEvents() {
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('logoutButton').addEventListener('click', logout);
  document.getElementById('deniedLogoutButton').addEventListener('click', logout);
  document.getElementById('refreshButton').addEventListener('click', () => loadDashboard(true));
  document.getElementById('yearFilter').addEventListener('change', renderDashboard);
  document.getElementById('importButton').addEventListener('click', openImportModal);
  document.getElementById('openImportButton').addEventListener('click', openImportModal);
  document.getElementById('closeImportModalButton').addEventListener('click', closeImportModal);
  document.getElementById('clearImportButton').addEventListener('click', clearImportSelection);
  document.getElementById('startImportButton').addEventListener('click', startMonthlyImport);
  document.getElementById('csvFileInput').addEventListener('change', updateSelectedImportFile);
  document.getElementById('importModal').addEventListener('click', event => {
    if (event.target.id === 'importModal') closeImportModal();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeImportModal();
  });
  window.addEventListener('message', handleImportMessage);
}

function configureImportUi() {
  const rawUrl = String(CONFIG.IMPORT_APP_URL || '').trim();
  importAppUrl = isUsableImportUrl(rawUrl) ? rawUrl.replace(/\/+$/, '') : '';
  updateImportSetupStatus();
}

function isUsableImportUrl(url) {
  return url.startsWith('https://') && !url.includes('REPLACE_ME') && !url.includes('YOUR_') && /\/exec(?:$|\?)/.test(url);
}

function updateImportSetupStatus() {
  const status = document.getElementById('importSetupStatus');
  if (!status) return;

  if (importAppUrl) {
    status.textContent = 'ระบบนำเข้าผ่าน GitHub พร้อมใช้งาน';
    status.classList.add('ready');
    status.classList.remove('not-ready');
  } else {
    status.textContent = 'ยังไม่ได้ตั้งค่า IMPORT_APP_URL';
    status.classList.add('not-ready');
    status.classList.remove('ready');
  }
}

function applyImportPermission() {
  const isAdmin = currentUserRole === 'admin';
  document.getElementById('importButton')?.classList.toggle('hidden', !isAdmin);
  document.getElementById('monthlyImportCard')?.classList.toggle('hidden', !isAdmin);
  if (!isAdmin) closeImportModal(true);
}

function openImportModal() {
  if (currentUserRole !== 'admin') {
    setDashboardMessage('บัญชีนี้ดู Dashboard ได้ แต่ไม่มีสิทธิ์นำเข้าข้อมูล', 'error');
    return;
  }

  resetImportProgress();
  if (!document.getElementById('csvFileInput').files?.length) setImportResult('', '');
  const modal = document.getElementById('importModal');
  const warning = document.getElementById('importMissingConfig');
  const workspace = document.getElementById('importWorkspace');
  const startButton = document.getElementById('startImportButton');
  const clearButton = document.getElementById('clearImportButton');

  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');

  const ready = Boolean(importAppUrl);
  warning.classList.toggle('hidden', ready);
  workspace.classList.toggle('hidden', !ready);
  startButton.disabled = !ready;
  clearButton.disabled = !ready;
}

function closeImportModal(force = false) {
  const modal = document.getElementById('importModal');
  if (!modal || modal.classList.contains('hidden')) return;
  if (importBusy && !force) {
    setImportResult('loading', 'ระบบกำลังนำเข้าข้อมูล กรุณารอจนเสร็จก่อนปิดหน้าต่าง');
    return;
  }
  modal.classList.add('hidden');
  document.body.classList.remove('modal-open');
}

function updateSelectedImportFile() {
  const file = document.getElementById('csvFileInput').files?.[0];
  const label = document.getElementById('selectedFile');
  label.textContent = file ? `เลือกแล้ว: ${file.name} (${formatBytes(file.size)})` : 'ยังไม่ได้เลือกไฟล์';
  resetImportProgress();
}

function clearImportSelection() {
  if (importBusy) return;
  document.getElementById('csvFileInput').value = '';
  updateSelectedImportFile();
  setImportResult('', '');
}

async function startMonthlyImport() {
  if (importBusy) return;
  if (currentUserRole !== 'admin') return setImportResult('fail', 'บัญชีนี้ไม่มีสิทธิ์นำเข้าข้อมูล');
  if (!importAppUrl) return setImportResult('fail', 'ยังไม่ได้ตั้งค่า IMPORT_APP_URL ใน config.js');

  const input = document.getElementById('csvFileInput');
  const file = input.files?.[0];
  if (!file) return setImportResult('fail', 'กรุณาเลือกไฟล์ .csv ก่อน');
  if (!file.name.toLowerCase().endsWith('.csv')) return setImportResult('fail', 'ไฟล์ที่เลือกไม่ใช่ไฟล์ .csv');
  if (file.size > MAX_IMPORT_FILE_BYTES) return setImportResult('fail', 'ไฟล์ใหญ่เกิน 25 MB กรุณาตรวจสอบว่าเลือกไฟล์ Export ที่ถูกต้อง');

  setImportBusy(true);
  resetImportProgress();
  setImportStep(1, 'active');
  setImportResult('loading', 'กำลังอ่านไฟล์ CSV ภายในเครื่อง...');

  try {
    const csvText = await readFileAsText(file);
    if (!csvText.trim()) throw new Error('ไฟล์ว่าง ไม่มีข้อมูลสำหรับนำเข้า');

    setImportStep(1, 'done');
    setImportStep(2, 'active');
    setImportResult('loading', 'กำลังส่งข้อมูลไปยัง Apps Script และ Google Sheets กรุณาอย่าปิดหน้าต่างนี้');

    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session?.access_token) throw new Error('Session หมดอายุ กรุณาออกจากระบบแล้วเข้าสู่ระบบใหม่');

    currentSession = data.session;
    currentImportRequestId = createRequestId();

    const form = document.getElementById('importTransportForm');
    form.action = importAppUrl;
    document.getElementById('importRequestIdField').value = currentImportRequestId;
    document.getElementById('importFileNameField').value = file.name;
    document.getElementById('importAccessTokenField').value = data.session.access_token;
    document.getElementById('importClientOriginField').value = window.location.origin;
    document.getElementById('importCsvTextField').value = csvText;

    form.submit();
    importTimeoutId = window.setTimeout(() => {
      document.getElementById('importCsvTextField').value = '';
      document.getElementById('importAccessTokenField').value = '';
      currentImportRequestId = '';
      setImportBusy(false);
      setImportStep(2, 'error');
      setImportResult('fail', 'ระบบใช้เวลานานเกิน 15 นาที กรุณาตรวจ Import_Log ใน Google Sheets ก่อนลองใหม่ เพื่อป้องกันข้อมูลซ้ำ');
    }, IMPORT_TIMEOUT_MS);
  } catch (error) {
    setImportBusy(false);
    setImportStep(1, 'error');
    setImportResult('fail', error?.message || 'อ่านหรือส่งไฟล์ไม่สำเร็จ');
  }
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => resolve(String(event.target?.result || ''));
    reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ กรุณาเลือกไฟล์ใหม่'));
    reader.readAsText(file, 'UTF-8');
  });
}

function handleImportMessage(event) {
  const frame = document.getElementById('importTransportFrame');
  if (!frame || event.source !== frame.contentWindow) return;

  const data = event.data || {};
  if (data.source !== 'gem5000-import-backend' || data.type !== 'result') return;
  if (!currentImportRequestId || data.requestId !== currentImportRequestId) return;

  window.clearTimeout(importTimeoutId);
  importTimeoutId = null;
  document.getElementById('importCsvTextField').value = '';
  document.getElementById('importAccessTokenField').value = '';

  if (!data.ok) {
    currentImportRequestId = '';
    setImportBusy(false);
    setImportStep(2, 'error');
    setImportResult('fail', data.message || 'นำเข้าข้อมูลไม่สำเร็จ');
    return;
  }

  currentImportRequestId = '';
  setImportStep(2, 'done');
  setImportStep(3, 'done');
  setImportStep(4, 'done');
  setImportBusy(false);

  const lines = [
    'นำเข้าข้อมูลสำเร็จ',
    '',
    `ข้อมูลในไฟล์ทั้งหมด: ${formatNumber(data.totalRows)} แถว`,
    `เพิ่มข้อมูลใหม่: ${formatNumber(data.addedRows)} แถว`,
    `ซ้ำกับ RawData เดิม: ${formatNumber(data.duplicateExistingRows)} แถว`,
    `ซ้ำภายในไฟล์เดียวกัน: ${formatNumber(data.duplicateInFileRows)} แถว`,
    '',
    data.syncMessage || 'อัปเดตข้อมูลสรุปเรียบร้อย'
  ];
  setImportResult('ok', lines.join('\n'));
  document.getElementById('csvFileInput').value = '';
  updateSelectedImportFileWithoutReset();
  setDashboardMessage(`นำเข้าข้อมูลสำเร็จ เพิ่มข้อมูลใหม่ ${formatNumber(data.addedRows)} แถว`, 'success');
  loadDashboard(false);
}

function updateSelectedImportFileWithoutReset() {
  const file = document.getElementById('csvFileInput').files?.[0];
  document.getElementById('selectedFile').textContent = file ? `เลือกแล้ว: ${file.name} (${formatBytes(file.size)})` : 'ยังไม่ได้เลือกไฟล์';
}

function createRequestId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `gem-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setImportBusy(busy) {
  importBusy = busy;
  document.getElementById('csvFileInput').disabled = busy;
  document.getElementById('clearImportButton').disabled = busy;
  document.getElementById('closeImportModalButton').disabled = busy;
  const button = document.getElementById('startImportButton');
  button.disabled = busy;
  button.textContent = busy ? 'กำลังนำเข้าข้อมูล...' : 'เริ่มนำเข้าข้อมูล';
}

function resetImportProgress() {
  if (importBusy) return;
  document.querySelectorAll('[data-import-step]').forEach(element => {
    element.classList.remove('active', 'done', 'error');
  });
}

function setImportStep(step, state) {
  const element = document.querySelector(`[data-import-step="${step}"]`);
  if (!element) return;
  element.classList.remove('active', 'done', 'error');
  if (state) element.classList.add(state);
}

function setImportResult(type, message) {
  const box = document.getElementById('importResult');
  box.textContent = message || '';
  box.className = 'import-result' + (type ? ` ${type}` : ' hidden');
}

async function handleLogin(event) {
  event.preventDefault();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const button = document.getElementById('loginButton');
  const errorBox = document.getElementById('loginError');
  errorBox.classList.add('hidden');
  button.disabled = true;
  button.textContent = 'กำลังเข้าสู่ระบบ...';

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  button.disabled = false;
  button.textContent = 'เข้าสู่ระบบ';

  if (error) {
    errorBox.textContent = 'เข้าสู่ระบบไม่สำเร็จ: ' + error.message;
    errorBox.classList.remove('hidden');
    return;
  }
  await openAuthorizedSession(data.session);
}

async function openAuthorizedSession(session) {
  showScreen('loadingScreen');
  currentSession = session;
  const userId = session.user.id;
  const { data: allowed, error } = await supabaseClient
    .from('gem5000_allowed_users')
    .select('role,is_active,email')
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !allowed || !allowed.is_active) {
    currentUserRole = '';
    applyImportPermission();
    showScreen('accessDeniedScreen');
    return;
  }

  currentUserRole = allowed.role || 'viewer';
  document.getElementById('userEmail').textContent = session.user.email || allowed.email || 'Authorized user';
  applyImportPermission();
  showScreen('dashboardScreen');
  await loadDashboard(false);
}

async function logout() {
  destroyCharts();
  currentSession = null;
  currentUserRole = '';
  currentImportRequestId = '';
  applyImportPermission();
  await supabaseClient.auth.signOut();
  showScreen('loginScreen');
}

async function loadDashboard(showSuccess) {
  setDashboardMessage('กำลังโหลดข้อมูลจาก Supabase...', '');
  const [workloadResult, syncResult] = await Promise.all([
    supabaseClient
      .from('gem5000_workload_monthly')
      .select('month,dimension_type,dimension_value,workload,synced_at')
      .order('month', { ascending: true }),
    supabaseClient
      .from('gem5000_sync_runs')
      .select('synced_at,source_row_count,row_count,status')
      .order('synced_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  ]);

  if (workloadResult.error) {
    setDashboardMessage('โหลดข้อมูลไม่สำเร็จ: ' + workloadResult.error.message, 'error');
    return;
  }

  allRows = workloadResult.data || [];
  latestSync = syncResult.data || null;
  populateYearFilter(allRows);
  renderDashboard();
  setDashboardMessage(showSuccess ? 'รีเฟรชข้อมูลเรียบร้อย' : '', showSuccess ? 'success' : '');
}

function populateYearFilter(rows) {
  const select = document.getElementById('yearFilter');
  const current = select.value || 'all';
  const years = [...new Set(rows.map(row => String(row.month).slice(0, 4)))].sort();
  select.innerHTML = '<option value="all">ทุกปี</option>' + years.map(year => `<option value="${year}">${year}</option>`).join('');
  select.value = years.includes(current) || current === 'all' ? current : 'all';
}

function renderDashboard() {
  const year = document.getElementById('yearFilter').value;
  const filtered = year === 'all' ? allRows : allRows.filter(row => String(row.month).startsWith(year));
  const months = [...new Set(filtered.map(row => monthKey(row.month)))].sort();

  if (!months.length) {
    destroyCharts();
    updateKpis([], []);
    updateImportSummary([]);
    setDashboardMessage('ไม่พบข้อมูลในช่วงที่เลือก', 'error');
    return;
  }

  const groupData = makeChartData(filtered, months, 'group', ['LAB', 'Nurse']);
  const allData = makeChartData(filtered, months, 'all', ['ALL']);
  const groupAllData = { labels: months, series: [...groupData.series, ...allData.series] };
  const areaNames = orderedValues(filtered, 'area', AREA_ORDER);
  const analyzerNames = orderedValues(filtered, 'analyzer', ANALYZER_ORDER);

  destroyCharts();
  renderLineChart('groupAllChart', groupAllData);
  renderLineChart('areaChart', makeChartData(filtered, months, 'area', areaNames));
  renderLineChart('analyzerChart', makeChartData(filtered, months, 'analyzer', analyzerNames));
  updateKpis(months, allData.series[0]?.data || []);
  updateImportSummary(months);
}

function orderedValues(rows, type, preferred) {
  const values = [...new Set(rows.filter(row => row.dimension_type === type).map(row => row.dimension_value))];
  return [...preferred.filter(v => values.includes(v)), ...values.filter(v => !preferred.includes(v)).sort()];
}

function makeChartData(rows, months, type, names) {
  const lookup = new Map();
  rows.filter(row => row.dimension_type === type).forEach(row => {
    lookup.set(`${monthKey(row.month)}|${row.dimension_value}`, Number(row.workload) || 0);
  });
  return {
    labels: months,
    series: names.map(name => ({ name, data: months.map(month => lookup.get(`${month}|${name}`) || 0) }))
  };
}

function renderLineChart(canvasId, chartData) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  const datasets = chartData.series.map((item, index) => {
    const isAll = item.name === 'ALL';
    const color = isAll ? '#111827' : COLORS[index % COLORS.length];
    return {
      label: item.name,
      data: item.data,
      borderColor: color,
      backgroundColor: color,
      pointBackgroundColor: color,
      pointBorderColor: '#ffffff',
      pointBorderWidth: 2,
      borderWidth: isAll ? 3 : 2,
      borderDash: isAll ? [7, 5] : [],
      pointRadius: isAll ? 5 : 4,
      pointHoverRadius: 7,
      tension: 0.25,
      fill: false
    };
  });

  const chart = new Chart(ctx, {
    type: 'line',
    data: { labels: chartData.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      normalized: true,
      layout: { padding: { top: 46, right: 32, bottom: 18, left: 16 } },
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, font: { size: 12, weight: 'bold' } } },
        tooltip: { callbacks: { label: context => `${context.dataset.label}: ${formatNumber(context.raw)}` } },
        datalabels: {
          display: context => (Number(context.dataset.data[context.dataIndex]) || 0) !== 0,
          formatter: value => formatNumber(value),
          align: context => {
            if (context.dataset.label === 'ALL') return 'top';
            if (context.dataset.label === 'Nurse') return 'bottom';
            return context.datasetIndex % 2 === 0 ? 'top' : 'bottom';
          },
          anchor: context => context.dataset.label === 'Nurse' ? 'start' : 'end',
          offset: context => 4 + ((context.datasetIndex % 3) * 2),
          clamp: true,
          clip: false,
          backgroundColor: 'rgba(255,255,255,.95)',
          borderColor: context => context.dataset.borderColor || '#111827',
          borderWidth: 1.2,
          borderRadius: 5,
          color: context => context.dataset.borderColor || '#111827',
          padding: { top: 2, bottom: 2, left: 4, right: 4 },
          font: { size: 9, weight: 'bold' }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 45, minRotation: 0, font: { size: 10, weight: 'bold' } } },
        y: { beginAtZero: true, ticks: { callback: value => formatNumber(value) } }
      }
    }
  });
  chartInstances.push(chart);
}

function updateKpis(months, allValues) {
  const latestIndex = months.length - 1;
  const latest = latestIndex >= 0 ? allValues[latestIndex] || 0 : 0;
  const total = allValues.reduce((sum, value) => sum + (Number(value) || 0), 0);
  document.getElementById('latestWorkload').textContent = formatNumber(latest);
  document.getElementById('latestMonth').textContent = latestIndex >= 0 ? months[latestIndex] : '-';
  document.getElementById('periodWorkload').textContent = formatNumber(total);
  document.getElementById('monthCount').textContent = formatNumber(months.length);
  document.getElementById('lastSyncTime').textContent = latestSync?.synced_at ? new Date(latestSync.synced_at).toLocaleString('th-TH') : '-';
  document.getElementById('syncSourceRows').textContent = latestSync ? `ข้อมูลต้นทาง ${formatNumber(latestSync.source_row_count)} แถว` : 'ยังไม่มีประวัติ Sync';
}

function updateImportSummary(months) {
  const latest = months.length ? months[months.length - 1] : '-';
  const element = document.getElementById('importLatestMonth');
  if (element) element.textContent = latest;
}

function destroyCharts() {
  while (chartInstances.length) chartInstances.pop().destroy();
}

function monthKey(value) { return String(value || '').slice(0, 7); }
function formatNumber(value) { return (Number(value) || 0).toLocaleString('th-TH'); }
function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function setDashboardMessage(message, type) {
  const box = document.getElementById('dashboardMessage');
  box.textContent = message;
  box.className = 'message' + (type ? ` ${type}` : '');
  box.classList.toggle('hidden', !message);
}

window.addEventListener('DOMContentLoaded', init);
