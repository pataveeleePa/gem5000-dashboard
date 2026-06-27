'use strict';

Chart.register(ChartDataLabels);

const CONFIG = window.GEM5000_CONFIG || {};
const screens = ['setupScreen', 'loadingScreen', 'loginScreen', 'accessDeniedScreen', 'dashboardScreen'];
const chartInstances = [];
let supabaseClient = null;
let allRows = [];
let latestSync = null;

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
  const { data } = await supabaseClient.auth.getSession();
  if (data.session) await openAuthorizedSession(data.session);
  else showScreen('loginScreen');

  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_OUT' || !session) showScreen('loginScreen');
  });
}

function wireEvents() {
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('logoutButton').addEventListener('click', logout);
  document.getElementById('deniedLogoutButton').addEventListener('click', logout);
  document.getElementById('refreshButton').addEventListener('click', () => loadDashboard(true));
  document.getElementById('yearFilter').addEventListener('change', renderDashboard);

  if (CONFIG.IMPORT_APP_URL) {
    const link = document.getElementById('importLink');
    link.href = CONFIG.IMPORT_APP_URL;
    link.classList.remove('hidden');
  }
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
  const userId = session.user.id;
  const { data: allowed, error } = await supabaseClient
    .from('gem5000_allowed_users')
    .select('role,is_active,email')
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !allowed || !allowed.is_active) {
    showScreen('accessDeniedScreen');
    return;
  }

  document.getElementById('userEmail').textContent = session.user.email || allowed.email || 'Authorized user';
  showScreen('dashboardScreen');
  await loadDashboard(false);
}

async function logout() {
  destroyCharts();
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

function destroyCharts() {
  while (chartInstances.length) chartInstances.pop().destroy();
}
function monthKey(value) { return String(value || '').slice(0, 7); }
function formatNumber(value) { return (Number(value) || 0).toLocaleString('th-TH'); }
function setDashboardMessage(message, type) {
  const box = document.getElementById('dashboardMessage');
  box.textContent = message;
  box.className = 'message' + (type ? ` ${type}` : '');
  box.classList.toggle('hidden', !message);
}

window.addEventListener('DOMContentLoaded', init);
