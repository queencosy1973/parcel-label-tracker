/**
 * QueenCosy Parcel Label AI Tracker & 3-Way Re-Check Web Application (app.js)
 * Connects:
 * - Tab 1: 3-Way Re-Check & Order Matcher (Orders + QR Scans + Label Photos)
 * - Tab 2: Upload / Mobile Camera Label Photo & Gemini Vision AI Queue
 * - Tab 3: Next-Day Follow-up Delivery Status Monitor & Carrier Web Linker
 * - Tab 4: LINE Bot Webhook & Gemini API Configuration
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const state = {
    activeTab: 'tab-dashboard',
    activeDate: TrackerDB.getTodayString(),

    // Daily data for activeDate
    qrSystemOrders: [],
    extraOrders: [],
    orders: [],
    qrScans: [],
    labelScans: [],
    reconciled: { items: [], summary: {} },

    // Tab 1 Filters
    dashboardFilter: 'ALL',
    dashboardCarrier: 'ALL',
    dashboardSearch: '',

    // Tab 2 Selected Label Scan for Inspection
    selectedScanId: '',

    // Tab 3 Follow-Up Monitor State
    followUpRange: 'selected', // 'yesterday', 'selected', 'last3', 'last7'
    followUpFilterStatus: 'ALL',
    followUpSearch: '',
    followUpMultiDayData: [], // Array of daily data objects
    followUpSelectedKeys: new Set(),

    // Cloud Config
    config: TrackerDB.getLocalConfig(),
    supabaseClient: null
  };

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  let toastTimer = null;
  function showToast(msg) {
    const toast = $('app-toast');
    const txt = $('app-toast-text');
    if (!toast || !txt) return;
    txt.textContent = msg;
    toast.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.add('hidden');
    }, 3800);
  }

  function updateSyncBadge(status, customText) {
    const badge = $('cloud-sync-badge');
    if (!badge) return;

    if (status === 'syncing') {
      badge.className = 'px-2.5 py-1 text-[11px] font-semibold rounded-full bg-sky-500/20 text-sky-300 border border-sky-400/30 flex items-center gap-1.5';
      badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-sky-400 animate-ping"></span><span>${escapeHtml(customText || 'กำลังซิงค์...')}</span>`;
    } else if (status === 'synced') {
      const now = new Date();
      const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      badge.className = 'px-2.5 py-1 text-[11px] font-semibold rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1.5';
      badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400"></span><span>${escapeHtml(customText || `ซิงค์ล่าสุด ${t}`)}</span>`;
    } else {
      badge.className = 'px-2.5 py-1 text-[11px] font-semibold rounded-full bg-amber-500/20 text-amber-300 border border-amber-400/30 flex items-center gap-1.5';
      badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-400"></span><span>${escapeHtml(customText || 'โหมดในเครื่อง')}</span>`;
    }
  }

  // ===========================================================================
  // 1. INITIALIZATION & REALTIME CLOUD SUBSCRIPTION
  // ===========================================================================

  window.addEventListener('DOMContentLoaded', async () => {
    initUIControls();
    await loadCloudConfigAndPopulateSettings();
    initRealtimeSubscription();
    await refreshActiveDateData(false);
    setInterval(() => {
      refreshActiveDateData(false);
    }, 20000);
  });

  function initRealtimeSubscription() {
    if (typeof window.supabase === 'undefined' || state.supabaseClient) return;
    try {
      const cfg = state.config;
      state.supabaseClient = window.supabase.createClient(
        cfg.supabaseUrl || TrackerDB.DEFAULT_SUPABASE_URL,
        cfg.supabaseKey || TrackerDB.DEFAULT_SUPABASE_KEY
      );
      state.supabaseClient
        .channel('qc-parcel-label-tracker-live')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'production_batches' },
          (payload) => {
            const bid = payload?.new?.batch_id || payload?.old?.batch_id || '';
            if (
              bid.startsWith('QC_LABEL_SCAN_') ||
              bid.startsWith('QC_LABEL_ORDERS_') ||
              bid.startsWith('QC_PARCEL_DATA_')
            ) {
              refreshActiveDateData(false);
            }
          }
        )
        .subscribe();
    } catch (e) {
      console.warn('Realtime subscription warning:', e);
    }
  }

  async function refreshActiveDateData(showNotification = false) {
    updateSyncBadge('syncing');
    try {
      const daily = await TrackerDB.syncDailyDataFromCloud(state.activeDate);
      state.qrSystemOrders = daily.qrSystemOrders;
      state.extraOrders = daily.extraOrders;
      state.orders = daily.orders;
      state.qrScans = daily.qrScans;
      state.labelScans = daily.labelScans;
      state.reconciled = daily.reconciled;

      if (state.activeTab === 'tab-followup') {
        await loadFollowUpRangeData();
      }

      renderAll();
      updateSyncBadge('synced');
      if (showNotification) {
        const s = state.reconciled.summary;
        showToast(`ซิงค์สำเร็จ! ออเดอร์ ${s.totalOrders} | ยิง QR ${s.qrScannedCount} | รูปลาเบล ${s.labelPhotoCount} | ครบ 3 ทาง ${s.verifiedAllCount}`);
      }
    } catch (err) {
      console.warn('refreshActiveDateData error:', err);
      updateSyncBadge('offline');
    }
  }

  function recomputeLocalReconciliation() {
    state.orders = TrackerDB.deduplicateOrderArray([...state.qrSystemOrders, ...state.extraOrders]);
    state.labelScans = TrackerDB.deduplicateLabelScans(state.labelScans);
    state.reconciled = TrackerDB.reconcileThreeWayStatus(
      state.orders,
      state.qrScans,
      state.labelScans,
      state.activeDate
    );
  }

  // ===========================================================================
  // 2. UI CONTROLS & NAVIGATION
  // ===========================================================================

  function initUIControls() {
    // Set initial date input
    const dateInput = $('active-date-input');
    if (dateInput) {
      dateInput.value = state.activeDate;
      dateInput.addEventListener('change', (e) => {
        state.activeDate = e.target.value || TrackerDB.getTodayString();
        refreshActiveDateData(true);
      });
    }

    $('btn-prev-date')?.addEventListener('click', () => {
      state.activeDate = TrackerDB.adjustDateString(state.activeDate, -1);
      if (dateInput) dateInput.value = state.activeDate;
      refreshActiveDateData(true);
    });

    $('btn-next-date')?.addEventListener('click', () => {
      state.activeDate = TrackerDB.adjustDateString(state.activeDate, 1);
      if (dateInput) dateInput.value = state.activeDate;
      refreshActiveDateData(true);
    });

    $('btn-yesterday-date')?.addEventListener('click', () => {
      state.activeDate = TrackerDB.adjustDateString(TrackerDB.getTodayString(), -1);
      if (dateInput) dateInput.value = state.activeDate;
      refreshActiveDateData(true);
    });

    $('btn-today-date')?.addEventListener('click', () => {
      state.activeDate = TrackerDB.getTodayString();
      if (dateInput) dateInput.value = state.activeDate;
      refreshActiveDateData(true);
    });

    $('btn-sync-now')?.addEventListener('click', () => {
      refreshActiveDateData(true);
    });

    const staffInput = $('input-staff-name');
    if (staffInput) {
      staffInput.value = state.config.staffName || 'ฝ่ายติดตามพัสดุ';
      staffInput.addEventListener('change', () => {
        state.config.staffName = staffInput.value.trim() || 'ฝ่ายติดตามพัสดุ';
        TrackerDB.saveLocalConfig({ staffName: state.config.staffName });
      });
    }

    // Tab Switching
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const target = btn.dataset.tab;
        await switchTab(target);
      });
    });

    // Quick button on Dashboard to jump to AI Upload tab
    $('btn-quick-upload-photo')?.addEventListener('click', () => {
      switchTab('tab-ai-queue');
    });

    // Dashboard Filter Pills
    document.querySelectorAll('#dashboard-filter-pills .filter-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        state.dashboardFilter = pill.dataset.filter || 'ALL';
        document.querySelectorAll('#dashboard-filter-pills .filter-pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        renderDashboardTable();
      });
    });

    $('filter-dashboard-carrier')?.addEventListener('change', (e) => {
      state.dashboardCarrier = e.target.value || 'ALL';
      renderDashboardTable();
    });

    $('input-dashboard-search')?.addEventListener('input', (e) => {
      state.dashboardSearch = (e.target.value || '').trim();
      renderDashboardTable();
    });

    // Sample Data Loader
    $('btn-load-sample-data')?.addEventListener('click', handleLoadSampleData);

    // Export Excel Buttons
    $('btn-export-dashboard-excel')?.addEventListener('click', () => exportDailyReportExcel(state.reconciled.items, state.activeDate));
    $('btn-export-followup-excel')?.addEventListener('click', () => {
      const items = getFlattenedFollowUpItems();
      exportDailyReportExcel(items, `${state.followUpRange}_${state.activeDate}`);
    });

    // Import Orders Modal
    setupImportOrdersModal();

    // Tab 2 Upload & AI Inspector Controls
    setupTab2AiQueueControls();

    // Tab 3 Follow-Up Monitor Controls
    setupTab3FollowUpControls();

    // Tab 4 Settings Controls
    setupTab4SettingsControls();

    // Photo Viewer Modal Close
    $('btn-close-photo-viewer')?.addEventListener('click', () => {
      $('modal-photo-viewer')?.classList.add('hidden');
    });
  }

  async function switchTab(tabId) {
    state.activeTab = tabId;
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      if (btn.dataset.tab === tabId) btn.classList.add('active');
      else btn.classList.remove('active');
    });

    ['tab-dashboard', 'tab-ai-queue', 'tab-followup', 'tab-settings'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      if (id === tabId) el.classList.remove('hidden');
      else el.classList.add('hidden');
    });

    if (tabId === 'tab-followup') {
      await loadFollowUpRangeData();
    }
    renderAll();
  }

  // ===========================================================================
  // 3. RENDER ALL VIEWS & TAB 1 (3-WAY RE-CHECK DASHBOARD)
  // ===========================================================================

  function renderAll() {
    const thaiDate = TrackerDB.formatThaiDateDisplay(state.activeDate);
    if ($('lbl-dashboard-date')) $('lbl-dashboard-date').textContent = `${thaiDate} (${state.activeDate})`;
    if ($('lbl-followup-selected-date')) $('lbl-followup-selected-date').textContent = thaiDate;

    const s = state.reconciled.summary || {};
    if ($('tab-badge-recheck')) $('tab-badge-recheck').textContent = (s.totalItems || 0).toLocaleString();
    if ($('tab-badge-photos')) $('tab-badge-photos').textContent = (state.labelScans.length || 0).toLocaleString();
    if ($('tab-badge-followup')) $('tab-badge-followup').textContent = (s.totalItems || 0).toLocaleString();

    renderDashboardKPIs();
    updateDashboardCarrierDropdown();
    renderDashboardTable();
    renderAiQueueTab();
    if (state.activeTab === 'tab-followup') {
      renderFollowUpTab();
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  function renderDashboardKPIs() {
    const s = state.reconciled.summary || {
      totalItems: 0,
      totalOrders: 0,
      totalUnits: 0,
      qrScannedCount: 0,
      labelPhotoCount: 0,
      verifiedAllCount: 0,
      photoOnlyCount: 0,
      qrOnlyCount: 0,
      orderPendingCount: 0,
      unmatchedPhotoCount: 0,
      issuesToFollowCount: 0
    };

    if ($('kpi-total-orders')) $('kpi-total-orders').textContent = s.totalOrders.toLocaleString();
    if ($('kpi-total-units')) $('kpi-total-units').textContent = `รวมสินค้า ${s.totalUnits.toLocaleString()} ชิ้น`;
    if ($('kpi-qr-scanned')) $('kpi-qr-scanned').textContent = s.qrScannedCount.toLocaleString();
    if ($('kpi-label-photo')) $('kpi-label-photo').textContent = s.labelPhotoCount.toLocaleString();
    if ($('kpi-verified-all')) $('kpi-verified-all').textContent = s.verifiedAllCount.toLocaleString();

    const pct = s.totalOrders > 0 ? Math.round((s.verifiedAllCount / s.totalOrders) * 100) : 0;
    if ($('kpi-verified-pct')) $('kpi-verified-pct').textContent = `(${pct}%)`;

    if ($('kpi-issues-count')) $('kpi-issues-count').textContent = s.issuesToFollowCount.toLocaleString();
    if ($('kpi-issues-breakdown')) {
      $('kpi-issues-breakdown').textContent = `ยังไม่ยิง QR: ${s.photoOnlyCount} • ไม่มีรูป: ${s.qrOnlyCount} • ค้างแพ็ค: ${s.orderPendingCount}`;
    }

    // Filter pill counters
    if ($('cnt-filter-all')) $('cnt-filter-all').textContent = s.totalItems || 0;
    if ($('cnt-filter-verified')) $('cnt-filter-verified').textContent = s.verifiedAllCount || 0;
    if ($('cnt-filter-photo-only')) $('cnt-filter-photo-only').textContent = s.photoOnlyCount || 0;
    if ($('cnt-filter-qr-only')) $('cnt-filter-qr-only').textContent = s.qrOnlyCount || 0;
    if ($('cnt-filter-pending')) $('cnt-filter-pending').textContent = s.orderPendingCount || 0;
    if ($('cnt-filter-unmatched')) $('cnt-filter-unmatched').textContent = s.unmatchedPhotoCount || 0;
  }

  function updateDashboardCarrierDropdown() {
    const sel = $('filter-dashboard-carrier');
    if (!sel) return;
    const prev = sel.value || 'ALL';
    const carriers = new Set();
    (state.reconciled.items || []).forEach((item) => {
      if (item.carrier) carriers.add(item.carrier);
    });

    let html = '<option value="ALL">🚚 ขนส่งทั้งหมด</option>';
    Array.from(carriers).sort().forEach((c) => {
      html += `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`;
    });
    sel.innerHTML = html;
    sel.value = carriers.has(prev) ? prev : 'ALL';
  }

  function getThreeWayBadgeHtml(status) {
    if (status === 'VERIFIED_ALL') {
      return `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">✅ ครบ 3 ทาง (100%)</span>`;
    }
    if (status === 'PHOTO_ONLY') {
      return `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-rose-100 text-rose-800 border border-rose-300 animate-pulse">📸 มีรูปลาเบล แต่ยังไม่ยิง QR!</span>`;
    }
    if (status === 'QR_ONLY') {
      return `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-100 text-amber-900 border border-amber-300">🔫 ยิง QR แล้ว (รอรูปใบลาเบล)</span>`;
    }
    if (status === 'UNMATCHED_PHOTO') {
      return `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-purple-100 text-purple-800 border border-purple-300">❓ มีรูปถ่าย (ไม่พบในออเดอร์)</span>`;
    }
    return `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-600 border border-slate-300">⏳ ออเดอร์ค้างแพ็ค/ค้างส่ง</span>`;
  }

  function renderDashboardTable() {
    const tbody = $('dashboard-table-body');
    if (!tbody) return;

    let list = [...(state.reconciled.items || [])];

    if (state.dashboardFilter !== 'ALL') {
      list = list.filter((x) => x.threeWayStatus === state.dashboardFilter);
    }
    if (state.dashboardCarrier !== 'ALL') {
      list = list.filter((x) => x.carrier === state.dashboardCarrier);
    }
    if (state.dashboardSearch) {
      const q = state.dashboardSearch.toLowerCase();
      list = list.filter((x) =>
        (x.trackingId && x.trackingId.toLowerCase().includes(q)) ||
        (x.orderId && x.orderId.toLowerCase().includes(q)) ||
        (x.sku && x.sku.toLowerCase().includes(q)) ||
        (x.customerName && x.customerName.toLowerCase().includes(q)) ||
        (x.province && x.province.toLowerCase().includes(q))
      );
    }

    if (list.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" class="py-14 text-center text-slate-400">
            <i data-lucide="package-search" class="w-10 h-10 mx-auto mb-2 text-slate-300"></i>
            <div class="font-bold text-sm text-slate-600">ยังไม่มีรายการพัสดุในตัวกรองนี้ของวันที่ ${escapeHtml(state.activeDate)}</div>
            <div class="text-xs text-slate-400 mt-1">กดปุ่ม "โหลดตัวอย่างทดสอบ" หรือ "อิมพอร์ตไฟล์คำสั่งซื้อ" หรือส่งรูปใบลาเบลเข้า LINE Group เพื่อเริ่มต้น</div>
          </td>
        </tr>
      `;
      if (typeof lucide !== 'undefined') lucide.createIcons();
      return;
    }

    let html = '';
    list.forEach((item, idx) => {
      const rowBg =
        item.threeWayStatus === 'VERIFIED_ALL'
          ? 'bg-emerald-50/35 hover:bg-emerald-50/70'
          : item.threeWayStatus === 'PHOTO_ONLY'
          ? 'bg-rose-50/45 hover:bg-rose-50/80'
          : item.threeWayStatus === 'QR_ONLY'
          ? 'bg-amber-50/35 hover:bg-amber-50/70'
          : 'hover:bg-slate-50';

      const qrCol = item.hasQr
        ? `<div class="inline-flex flex-col items-center">
             <span class="px-2 py-0.5 rounded-md bg-sky-100 text-sky-800 font-bold text-[11px]">✅ ยิง QR แล้ว</span>
             <span class="text-[10px] text-slate-500 mt-0.5">${escapeHtml(item.qrScanTime || '')} ${escapeHtml(item.qrScanner || '')}</span>
           </div>`
        : `<span class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-500 text-[11px] font-medium">ยังไม่ยิง QR</span>`;

      const photoCol = item.hasPhoto
        ? `<div class="inline-flex flex-col items-center">
             <button data-view-scan="${escapeHtml(item.labelScanId)}" class="btn-view-photo px-2.5 py-0.5 rounded-md bg-indigo-100 hover:bg-indigo-200 text-indigo-800 font-bold text-[11px] flex items-center gap-1 cursor-pointer transition">
               <i data-lucide="image" class="w-3 h-3"></i> ดูรูปใบลาเบล
             </button>
             <span class="text-[10px] text-slate-500 mt-0.5">${escapeHtml(item.labelScanTime || '')} (${item.labelSource === 'LINE_GROUP' ? 'LINE' : 'เว็บ'})</span>
           </div>`
        : `<span class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-500 text-[11px] font-medium">ยังไม่มีรูปลาเบล</span>`;

      html += `
        <tr class="${rowBg} transition border-b border-slate-100">
          <td class="py-3 px-3 text-center font-mono text-slate-400">${idx + 1}</td>
          <td class="py-3 px-3.5">
            <div class="font-mono font-bold text-slate-900 text-xs sm:text-sm">${escapeHtml(item.trackingId || 'ไม่มีเลข Tracking')}</div>
            <div class="flex items-center gap-1.5 mt-0.5">
              <span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200 text-[10px] font-semibold">${escapeHtml(item.carrier)}</span>
              <span class="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 text-[10px] font-semibold">${escapeHtml(item.platform)}</span>
            </div>
          </td>
          <td class="py-3 px-3.5">
            <div class="font-mono font-semibold text-slate-800">${escapeHtml(item.orderId || '-')}</div>
            <div class="text-[11px] text-slate-500 mt-0.5">
              ${escapeHtml([item.customerName, item.province ? `จ.${item.province}` : ''].filter(Boolean).join(' • ') || 'ไม่ระบุชื่อผู้รับ')}
            </div>
          </td>
          <td class="py-3 px-3.5 font-semibold text-slate-800 max-w-[260px]">
            <div class="truncate" title="${escapeHtml(item.sku)}">${escapeHtml(item.sku || '-')}</div>
          </td>
          <td class="py-3 px-3 text-center font-mono font-bold text-slate-900">${item.qty || 1}</td>
          <td class="py-3 px-3.5 text-center">${qrCol}</td>
          <td class="py-3 px-3.5 text-center">${photoCol}</td>
          <td class="py-3 px-3.5 text-center">${getThreeWayBadgeHtml(item.threeWayStatus)}</td>
          <td class="py-3 px-3.5 text-center">
            <div class="flex items-center justify-center gap-1.5">
              ${
                item.hasPhoto
                  ? `<button data-view-scan="${escapeHtml(item.labelScanId)}" class="btn-view-photo px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-bold cursor-pointer transition">ตรวจคู่รูป</button>`
                  : `<button data-upload-for="${escapeHtml(item.trackingId)}" class="btn-jump-upload px-2.5 py-1 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-[11px] font-bold cursor-pointer transition">+ อัปโหลดรูป</button>`
              }
            </div>
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
    if (typeof lucide !== 'undefined') lucide.createIcons();

    tbody.querySelectorAll('.btn-view-photo').forEach((btn) => {
      btn.addEventListener('click', () => {
        const scanId = btn.dataset.viewScan;
        openPhotoComparisonModal(scanId);
      });
    });

    tbody.querySelectorAll('.btn-jump-upload').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchTab('tab-ai-queue');
      });
    });
  }

  // ===========================================================================
  // 4. TAB 2: AI PHOTO UPLOAD, COMPRESSION & SIDE-BY-SIDE INSPECTOR
  // ===========================================================================

  function setupTab2AiQueueControls() {
    const dropzone = $('label-dropzone');
    const multiInput = $('input-multi-label-photos');
    const camInput = $('input-camera-capture');

    if (dropzone && multiInput) {
      dropzone.addEventListener('click', () => multiInput.click());
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dropzone-active');
      });
      dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dropzone-active');
      });
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dropzone-active');
        if (e.dataTransfer?.files?.length) {
          processUploadedLabelFiles(Array.from(e.dataTransfer.files));
        }
      });
    }

    multiInput?.addEventListener('change', (e) => {
      if (e.target.files?.length) {
        processUploadedLabelFiles(Array.from(e.target.files));
        e.target.value = '';
      }
    });

    camInput?.addEventListener('change', (e) => {
      if (e.target.files?.length) {
        processUploadedLabelFiles(Array.from(e.target.files));
        e.target.value = '';
      }
    });

    $('btn-save-label-edit')?.addEventListener('click', handleSaveInspectorEdit);
    $('btn-delete-label-scan')?.addEventListener('click', handleDeleteInspectorScan);
  }

  /**
   * Compresses image on client before sending to Gemini Vision & Supabase
   */
  function compressImageFile(file, maxWidth = 1280, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let w = img.width;
          let h = img.height;
          if (w > maxWidth) {
            h = Math.round((h * maxWidth) / w);
            w = maxWidth;
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          resolve({
            dataUrl,
            base64: dataUrl.split(',')[1],
            mimeType: 'image/jpeg'
          });
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function processUploadedLabelFiles(files) {
    if (!files || files.length === 0) return;

    const progressBox = $('ai-scan-progress-box');
    const progressText = $('ai-scan-progress-text');
    const progressCount = $('ai-scan-progress-count');
    const progressBar = $('ai-scan-progress-bar');

    if (progressBox) progressBox.classList.remove('hidden');

    const cfg = await TrackerDB.fetchCloudConfig();
    const apiKey = cfg.geminiApiKey || state.config.geminiApiKey || '';
    const model = cfg.geminiModel || state.config.geminiModel || 'gemini-flash-latest';

    let lastCreatedId = '';

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (progressText) progressText.textContent = `กำลังอ่านใบปะหน้าพัสดุด้วย AI (${file.name})...`;
      if (progressCount) progressCount.textContent = `${i + 1} / ${files.length}`;
      if (progressBar) progressBar.style.width = `${Math.round(((i + 1) / files.length) * 100)}%`;

      try {
        const compressed = await compressImageFile(file);
        let extracted;
        if (apiKey) {
          try {
            extracted = await TrackerDB.scanLabelImageWithGemini(
              compressed.base64,
              compressed.mimeType,
              apiKey,
              model
            );
          } catch (aiErr) {
            console.warn('Gemini OCR warning:', aiErr);
            extracted = TrackerDB.normalizeExtractedLabelData({
              trackingId: '',
              sku: `รอตรวจข้อมูล (${file.name})`,
              confidence: 'LOW',
              notes: aiErr.message
            });
          }
        } else {
          extracted = TrackerDB.normalizeExtractedLabelData({
            trackingId: '',
            sku: `กรุณาใส่คีย์ Gemini หรือกรอกเลขพัสดุ (${file.name})`,
            confidence: 'LOW'
          });
        }

        const saved = await TrackerDB.recordIncomingLabelScan(extracted, compressed.dataUrl, {
          date: state.activeDate,
          strictDate: true,
          sourceChannel: 'WEB_UPLOAD',
          senderName: state.config.staffName || 'อัปโหลดผ่านหน้าเว็บ'
        });

        lastCreatedId = saved.scan.id;
      } catch (err) {
        console.error('Upload label error:', err);
      }
    }

    if (progressBox) {
      setTimeout(() => progressBox.classList.add('hidden'), 1200);
    }

    await refreshActiveDateData(false);
    if (lastCreatedId) {
      selectScanForInspector(lastCreatedId);
    }
    showToast(`ประมวลผลรูปใบปะหน้าพัสดุสำเร็จ ${files.length} รูป!`);
  }

  function renderAiQueueTab() {
    const listEl = $('ai-queue-list');
    const countEl = $('ai-queue-count');
    if (!listEl) return;

    const scans = state.labelScans || [];
    if (countEl) countEl.textContent = scans.length.toLocaleString();

    if (scans.length === 0) {
      listEl.innerHTML = `
        <div class="p-10 text-center text-slate-400 text-xs">
          <i data-lucide="camera-off" class="w-8 h-8 mx-auto mb-2 text-slate-300"></i>
          <div>ยังไม่มีรูปถ่ายใบปะหน้าพัสดุในวันที่ ${escapeHtml(state.activeDate)}</div>
          <div class="mt-1">ส่งรูปเข้ากลุ่ม LINE หรือลากรูปลงกล่องด้านบนได้เลยครับ</div>
        </div>
      `;
      $('ai-inspector-empty')?.classList.remove('hidden');
      $('ai-inspector-panel')?.classList.add('hidden');
      return;
    }

    // Map each scan to its 3-way status from state.reconciled.items
    const itemByScanId = new Map();
    (state.reconciled.items || []).forEach((it) => {
      if (it.labelScanId) itemByScanId.set(it.labelScanId, it);
    });

    let html = '';
    scans.forEach((s) => {
      const isSelected = s.id === state.selectedScanId;
      const rec = itemByScanId.get(s.id);
      const status = rec ? rec.threeWayStatus : 'UNMATCHED_PHOTO';

      html += `
        <div data-scan-id="${escapeHtml(s.id)}" class="queue-item p-3.5 cursor-pointer transition flex items-start justify-between gap-2 ${isSelected ? 'bg-indigo-50 border-l-4 border-l-indigo-600' : 'hover:bg-slate-50'}">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="font-mono font-bold text-xs sm:text-sm text-slate-900">${escapeHtml(s.trackingId || 'รอระบุเลขพัสดุ')}</span>
              <span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-semibold">${escapeHtml(s.carrier)}</span>
            </div>
            <div class="text-xs text-slate-700 font-medium truncate mt-0.5">${escapeHtml(s.sku || '-')} (x${s.qty || 1})</div>
            <div class="text-[11px] text-slate-400 mt-0.5">
              Order: ${escapeHtml(s.orderId || '-')} • ${escapeHtml(s.scanTime || '')} (${s.sourceChannel === 'LINE_GROUP' ? 'LINE Bot' : 'เว็บ'})
            </div>
          </div>
          <div class="shrink-0 text-right">
            ${getThreeWayBadgeHtml(status)}
          </div>
        </div>
      `;
    });

    listEl.innerHTML = html;
    listEl.querySelectorAll('.queue-item').forEach((el) => {
      el.addEventListener('click', () => {
        selectScanForInspector(el.dataset.scanId);
      });
    });

    if (!state.selectedScanId && scans.length > 0) {
      selectScanForInspector(scans[0].id);
    } else if (state.selectedScanId) {
      const exists = scans.some((x) => x.id === state.selectedScanId);
      if (exists) populateInspectorPanel(state.selectedScanId);
    }
  }

  async function selectScanForInspector(scanId) {
    state.selectedScanId = scanId;
    document.querySelectorAll('#ai-queue-list .queue-item').forEach((el) => {
      if (el.dataset.scanId === scanId) {
        el.classList.add('bg-indigo-50', 'border-l-4', 'border-l-indigo-600');
      } else {
        el.classList.remove('bg-indigo-50', 'border-l-4', 'border-l-indigo-600');
      }
    });
    await populateInspectorPanel(scanId);
  }

  async function populateInspectorPanel(scanId) {
    const scan = (state.labelScans || []).find((x) => x.id === scanId);
    if (!scan) return;

    $('ai-inspector-empty')?.classList.add('hidden');
    $('ai-inspector-panel')?.classList.remove('hidden');

    if ($('edit-scan-id')) $('edit-scan-id').value = scan.id;
    if ($('edit-tracking-id')) $('edit-tracking-id').value = scan.trackingId || '';
    if ($('edit-carrier')) $('edit-carrier').value = scan.carrier || '';
    if ($('edit-platform')) $('edit-platform').value = scan.platform || '';
    if ($('edit-order-id')) $('edit-order-id').value = scan.orderId || '';
    if ($('edit-sku')) $('edit-sku').value = scan.sku || '';
    if ($('edit-qty')) $('edit-qty').value = scan.qty || 1;
    if ($('edit-customer')) $('edit-customer').value = scan.customerName || '';
    if ($('edit-province')) $('edit-province').value = scan.province || '';

    const rec = (state.reconciled.items || []).find((it) => it.labelScanId === scan.id);
    if ($('inspector-3way-badge')) {
      $('inspector-3way-badge').innerHTML = getThreeWayBadgeHtml(rec ? rec.threeWayStatus : 'UNMATCHED_PHOTO');
    }
    if ($('inspector-meta-subtitle')) {
      $('inspector-meta-subtitle').textContent = `รับรูปเมื่อ ${scan.scanTime || '-'} น. • ช่องทาง: ${scan.sourceChannel === 'LINE_GROUP' ? 'กลุ่ม LINE ส่งรูปพัสดุ' : 'อัปโหลดผ่านหน้าเว็บ'}`;
    }

    const imgEl = $('inspector-image');
    const loadingEl = $('inspector-image-loading');
    if (imgEl) {
      if (scan.imageDataUrl) {
        imgEl.src = scan.imageDataUrl;
        imgEl.classList.remove('hidden');
        loadingEl?.classList.add('hidden');
      } else {
        imgEl.classList.add('hidden');
        loadingEl?.classList.remove('hidden');
        const cloudImg = await TrackerDB.fetchLabelImage(scan.id);
        loadingEl?.classList.add('hidden');
        if (cloudImg) {
          scan.imageDataUrl = cloudImg;
          imgEl.src = cloudImg;
          imgEl.classList.remove('hidden');
        }
      }
    }
  }

  async function handleSaveInspectorEdit() {
    const scanId = $('edit-scan-id')?.value;
    if (!scanId) return;
    const idx = state.labelScans.findIndex((s) => s.id === scanId);
    if (idx === -1) return;

    const cleanTrk = TrackerDB.normalizeTracking($('edit-tracking-id')?.value || '');
    const cleanOrd = TrackerDB.normalizeOrderId($('edit-order-id')?.value || '');

    state.labelScans[idx] = Object.assign({}, state.labelScans[idx], {
      trackingId: cleanTrk,
      cleanTracking: cleanTrk,
      carrier: TrackerDB.detectCarrier(cleanTrk, $('edit-carrier')?.value || ''),
      platform: $('edit-platform')?.value.trim() || 'ทั่วไป',
      orderId: cleanOrd,
      cleanOrderId: cleanOrd,
      sku: $('edit-sku')?.value.trim() || '',
      qty: parseInt($('edit-qty')?.value, 10) || 1,
      customerName: $('edit-customer')?.value.trim() || '',
      province: $('edit-province')?.value.trim() || '',
      updatedAt: new Date().toISOString()
    });

    recomputeLocalReconciliation();
    await TrackerDB.saveLabelScansToCloud(state.activeDate, state.labelScans, state.config.staffName);
    renderAll();
    showToast('✅ บันทึกข้อมูลใบปะหน้าพัสดุและรีเช็ค 3 ทางเรียบร้อยแล้ว!');
  }

  async function handleDeleteInspectorScan() {
    const scanId = $('edit-scan-id')?.value;
    if (!scanId) return;
    if (!confirm('ต้องการลบรูปใบปะหน้าพัสดุรายการนี้ออกจากระบบใช่หรือไม่?')) return;

    state.labelScans = state.labelScans.filter((s) => s.id !== scanId);
    state.selectedScanId = state.labelScans[0]?.id || '';
    recomputeLocalReconciliation();
    await TrackerDB.saveLabelScansToCloud(state.activeDate, state.labelScans, state.config.staffName);
    renderAll();
    showToast('ลบรูปใบปะหน้าพัสดุเรียบร้อยแล้ว');
  }

  // ===========================================================================
  // 5. TAB 3: NEXT-DAY FOLLOW-UP STATUS MONITOR & CARRIER TRACKING LINKER
  // ===========================================================================

  function setupTab3FollowUpControls() {
    // Range Buttons
    document.querySelectorAll('.followup-range-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        state.followUpRange = btn.dataset.range || 'selected';
        document.querySelectorAll('.followup-range-btn').forEach((b) => {
          b.className = 'followup-range-btn px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition cursor-pointer';
        });
        btn.className = 'followup-range-btn px-3 py-2 rounded-xl bg-slate-900 text-white text-xs font-bold transition cursor-pointer';
        await loadFollowUpRangeData();
        renderFollowUpTab();
      });
    });

    // Status Card Filters
    document.querySelectorAll('#followup-status-cards .fstatus-card').forEach((card) => {
      card.addEventListener('click', () => {
        state.followUpFilterStatus = card.dataset.fstatus || 'ALL';
        document.querySelectorAll('#followup-status-cards .fstatus-card').forEach((c) => {
          c.classList.remove('ring-2', 'ring-indigo-600');
        });
        card.classList.add('ring-2', 'ring-indigo-600');
        renderFollowUpTab();
      });
    });

    // Search
    $('input-followup-search')?.addEventListener('input', (e) => {
      state.followUpSearch = (e.target.value || '').trim();
      renderFollowUpTab();
    });

    // Select All Checkbox
    $('chk-followup-all')?.addEventListener('change', (e) => {
      const checked = e.target.checked;
      document.querySelectorAll('.chk-followup-row').forEach((chk) => {
        chk.checked = checked;
        const key = chk.dataset.key;
        if (checked) state.followUpSelectedKeys.add(key);
        else state.followUpSelectedKeys.delete(key);
      });
      updateBulkSelectedCount();
    });

    // Bulk Status Apply Button
    $('btn-apply-bulk-status')?.addEventListener('click', handleApplyBulkFollowUpStatus);

    // Carrier Status Excel Upload
    $('input-carrier-status-excel')?.addEventListener('change', handleImportCarrierStatusExcel);
  }

  async function loadFollowUpRangeData() {
    const today = TrackerDB.getTodayString();
    let dates = [state.activeDate];

    if (state.followUpRange === 'yesterday') {
      dates = [TrackerDB.adjustDateString(today, -1)];
    } else if (state.followUpRange === 'selected') {
      dates = [state.activeDate];
    } else if (state.followUpRange === 'last3') {
      dates = [0, -1, -2].map((offset) => TrackerDB.adjustDateString(state.activeDate, offset));
    } else if (state.followUpRange === 'last7') {
      dates = [0, -1, -2, -3, -4, -5, -6].map((offset) => TrackerDB.adjustDateString(state.activeDate, offset));
    }

    state.followUpMultiDayData = await TrackerDB.fetchMultiDayDataFromCloud(dates);
  }

  function getFlattenedFollowUpItems() {
    const all = [];
    const dataList = state.followUpMultiDayData.length > 0
      ? state.followUpMultiDayData
      : [{ date: state.activeDate, reconciled: state.reconciled }];

    dataList.forEach((dayData) => {
      const d = dayData.date;
      (dayData.reconciled?.items || []).forEach((it) => {
        all.push(Object.assign({}, it, {
          shipDate: d,
          uniqueRowKey: `${d}|${it.cleanTracking || it.cleanOrderId || it.id}`
        }));
      });
    });
    return all;
  }

  function updateBulkSelectedCount() {
    if ($('bulk-selected-count')) {
      $('bulk-selected-count').textContent = state.followUpSelectedKeys.size.toLocaleString();
    }
  }

  function renderFollowUpTab() {
    const tbody = $('followup-table-body');
    if (!tbody) return;

    const allItems = getFlattenedFollowUpItems();

    // Update 6 status summary cards
    const counts = {
      ALL: allItems.length,
      PENDING_PICKUP: 0,
      IN_TRANSIT: 0,
      OUT_FOR_DELIVERY: 0,
      DELIVERED: 0,
      ISSUE_OR_RETURN: 0
    };

    allItems.forEach((it) => {
      const st = it.followUpStatus || 'PENDING_PICKUP';
      if (st === 'ISSUE' || st === 'RETURNED') counts.ISSUE_OR_RETURN++;
      if (counts[st] !== undefined) counts[st]++;
    });

    if ($('fcard-all')) $('fcard-all').textContent = counts.ALL.toLocaleString();
    if ($('fcard-pending')) $('fcard-pending').textContent = counts.PENDING_PICKUP.toLocaleString();
    if ($('fcard-transit')) $('fcard-transit').textContent = counts.IN_TRANSIT.toLocaleString();
    if ($('fcard-delivery')) $('fcard-delivery').textContent = counts.OUT_FOR_DELIVERY.toLocaleString();
    if ($('fcard-delivered')) $('fcard-delivered').textContent = counts.DELIVERED.toLocaleString();
    if ($('fcard-issue')) $('fcard-issue').textContent = counts.ISSUE_OR_RETURN.toLocaleString();

    let filtered = allItems;
    if (state.followUpFilterStatus === 'ISSUE_OR_RETURN') {
      filtered = filtered.filter((x) => x.followUpStatus === 'ISSUE' || x.followUpStatus === 'RETURNED');
    } else if (state.followUpFilterStatus !== 'ALL') {
      filtered = filtered.filter((x) => (x.followUpStatus || 'PENDING_PICKUP') === state.followUpFilterStatus);
    }

    if (state.followUpSearch) {
      const q = state.followUpSearch.toLowerCase();
      filtered = filtered.filter((x) =>
        (x.trackingId && x.trackingId.toLowerCase().includes(q)) ||
        (x.orderId && x.orderId.toLowerCase().includes(q)) ||
        (x.customerName && x.customerName.toLowerCase().includes(q)) ||
        (x.province && x.province.toLowerCase().includes(q)) ||
        (x.currentHub && x.currentHub.toLowerCase().includes(q)) ||
        (x.followUpNote && x.followUpNote.toLowerCase().includes(q))
      );
    }

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="py-12 text-center text-slate-400">
            <i data-lucide="truck" class="w-10 h-10 mx-auto mb-2 text-slate-300"></i>
            <div class="font-bold text-sm text-slate-600">ไม่พบรายการพัสดุในช่วงเวลา/สถานะที่เลือก</div>
          </td>
        </tr>
      `;
      if (typeof lucide !== 'undefined') lucide.createIcons();
      return;
    }

    let html = '';
    filtered.forEach((item) => {
      const isChecked = state.followUpSelectedKeys.has(item.uniqueRowKey);
      const trackUrl = TrackerDB.getCarrierTrackingUrl(item.carrier, item.trackingId);
      const stMeta = TrackerDB.FOLLOW_UP_STATUSES[item.followUpStatus] || TrackerDB.FOLLOW_UP_STATUSES.PENDING_PICKUP;

      html += `
        <tr class="hover:bg-slate-50 transition border-b border-slate-100">
          <td class="py-3 px-3 text-center">
            <input type="checkbox" class="chk-followup-row rounded cursor-pointer" data-key="${escapeHtml(item.uniqueRowKey)}" ${isChecked ? 'checked' : ''} />
          </td>
          <td class="py-3 px-3 font-mono text-xs font-bold text-slate-700 whitespace-nowrap">
            ${escapeHtml(TrackerDB.formatThaiDateDisplay(item.shipDate))}
          </td>
          <td class="py-3 px-3.5">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono font-bold text-slate-900 text-xs sm:text-sm">${escapeHtml(item.trackingId || '-')}</span>
              ${
                item.trackingId
                  ? `<button data-track="${escapeHtml(item.trackingId)}" data-url="${escapeHtml(trackUrl)}" class="btn-open-carrier-web px-2 py-0.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-[11px] font-bold flex items-center gap-1 cursor-pointer transition" title="คัดลอกเลขพัสดุและเปิดเว็บติดตามของขนส่งทันที">
                       🔗 เช็คเว็บขนส่ง
                     </button>`
                  : ''
              }
            </div>
            <div class="text-[11px] text-slate-500 mt-0.5">${escapeHtml(item.carrier)} • Order: ${escapeHtml(item.orderId || '-')}</div>
          </td>
          <td class="py-3 px-3.5">
            <div class="font-semibold text-slate-800">${escapeHtml([item.customerName, item.province ? `จ.${item.province}` : ''].filter(Boolean).join(' • ') || '-')}</div>
            <div class="text-[11px] text-slate-500 truncate max-w-[220px]">${escapeHtml(item.sku)} (x${item.qty || 1})</div>
          </td>
          <td class="py-3 px-3 text-center">
            ${getThreeWayBadgeHtml(item.threeWayStatus)}
          </td>
          <td class="py-3 px-3.5">
            <select data-date="${escapeHtml(item.shipDate)}" data-track="${escapeHtml(item.cleanTracking)}" data-order="${escapeHtml(item.cleanOrderId)}" class="sel-row-followup-status px-2.5 py-1.5 rounded-xl border text-xs font-bold focus:outline-none ${stMeta.badgeClass}">
              <option value="PENDING_PICKUP" ${item.followUpStatus === 'PENDING_PICKUP' ? 'selected' : ''}>⏳ รอขนส่งรับเข้าระบบ</option>
              <option value="IN_TRANSIT" ${item.followUpStatus === 'IN_TRANSIT' ? 'selected' : ''}>🚚 ส่งออกแล้ว / กำลังเดินทาง</option>
              <option value="OUT_FOR_DELIVERY" ${item.followUpStatus === 'OUT_FOR_DELIVERY' ? 'selected' : ''}>📦 กำลังนำจ่ายปลายทาง</option>
              <option value="DELIVERED" ${item.followUpStatus === 'DELIVERED' ? 'selected' : ''}>✅ จัดส่งสำเร็จ</option>
              <option value="ISSUE" ${item.followUpStatus === 'ISSUE' ? 'selected' : ''}>🚨 ติดปัญหา / ตามด่วน</option>
              <option value="RETURNED" ${item.followUpStatus === 'RETURNED' ? 'selected' : ''}>↩️ ตีกลับ</option>
            </select>
          </td>
          <td class="py-3 px-3.5">
            <div class="flex items-center gap-1.5">
              <input type="text" placeholder="ศูนย์คัดแยก/จ.ปัจจุบัน" value="${escapeHtml(item.currentHub || '')}" class="inp-row-hub px-2.5 py-1 rounded-lg border border-slate-300 text-xs w-36 focus:outline-none focus:border-indigo-500" />
              <input type="text" placeholder="พิมพ์หมายเหตุติดตามพัสดุ..." value="${escapeHtml(item.followUpNote || '')}" class="inp-row-note px-2.5 py-1 rounded-lg border border-slate-300 text-xs flex-1 min-w-[170px] focus:outline-none focus:border-indigo-500" />
              <button data-date="${escapeHtml(item.shipDate)}" data-track="${escapeHtml(item.cleanTracking)}" data-order="${escapeHtml(item.cleanOrderId)}" class="btn-save-row-followup px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold cursor-pointer transition shrink-0">
                บันทึก
              </button>
            </div>
          </td>
          <td class="py-3 px-3 text-center text-[11px] text-slate-500 whitespace-nowrap">
            ${item.checkedBy ? `<div class="font-bold text-slate-700">${escapeHtml(item.checkedBy)}</div><div class="text-[10px]">${escapeHtml(item.checkedAt || '')}</div>` : '-'}
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
    if (typeof lucide !== 'undefined') lucide.createIcons();

    // Checkbox listeners
    tbody.querySelectorAll('.chk-followup-row').forEach((chk) => {
      chk.addEventListener('change', () => {
        const k = chk.dataset.key;
        if (chk.checked) state.followUpSelectedKeys.add(k);
        else state.followUpSelectedKeys.delete(k);
        updateBulkSelectedCount();
      });
    });

    // Carrier Web Check Button (Copy tracking + open carrier site)
    tbody.querySelectorAll('.btn-open-carrier-web').forEach((btn) => {
      btn.addEventListener('click', () => {
        const trk = btn.dataset.track;
        const url = btn.dataset.url;
        if (navigator.clipboard && trk) {
          navigator.clipboard.writeText(trk).catch(() => {});
        }
        showToast(`📋 คัดลอกเลขพัสดุ ${trk} แล้ว กำลังเปิดเว็บขนส่ง...`);
        window.open(url, '_blank', 'noopener');
      });
    });

    // Instant Status Dropdown Change
    tbody.querySelectorAll('.sel-row-followup-status').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const tr = sel.closest('tr');
        const hub = tr?.querySelector('.inp-row-hub')?.value || '';
        const note = tr?.querySelector('.inp-row-note')?.value || '';
        await updateSingleParcelFollowUp(sel.dataset.date, sel.dataset.track, sel.dataset.order, {
          followUpStatus: sel.value,
          currentHub: hub,
          followUpNote: note
        });
      });
    });

    // Row Save Note Button
    tbody.querySelectorAll('.btn-save-row-followup').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const st = tr?.querySelector('.sel-row-followup-status')?.value || 'PENDING_PICKUP';
        const hub = tr?.querySelector('.inp-row-hub')?.value || '';
        const note = tr?.querySelector('.inp-row-note')?.value || '';
        await updateSingleParcelFollowUp(btn.dataset.date, btn.dataset.track, btn.dataset.order, {
          followUpStatus: st,
          currentHub: hub,
          followUpNote: note
        });
      });
    });
  }

  async function updateSingleParcelFollowUp(shipDate, cleanTracking, cleanOrderId, updates) {
    const staff = ($('input-staff-name')?.value || state.config.staffName || 'ฝ่ายติดตามพัสดุ').trim();
    const nowTime = new Date().toTimeString().slice(0, 5);

    const dayData = await TrackerDB.syncDailyDataFromCloud(shipDate);
    const scans = dayData.labelScans || [];
    const existingIdx = scans.findIndex((s) =>
      (cleanTracking && s.cleanTracking === cleanTracking) ||
      (cleanOrderId && s.cleanOrderId === cleanOrderId)
    );

    const matchedOrder = dayData.orders.find((o) =>
      (cleanTracking && o.cleanTracking === cleanTracking) ||
      (cleanOrderId && TrackerDB.normalizeOrderId(o.orderId) === cleanOrderId)
    );

    if (existingIdx !== -1) {
      scans[existingIdx] = Object.assign({}, scans[existingIdx], updates, {
        checkedBy: staff,
        checkedAt: `${TrackerDB.formatThaiDateDisplay(TrackerDB.getTodayString())} ${nowTime}`
      });
    } else {
      scans.push({
        id: `FUP-${Date.now()}-${Math.floor(Math.random() * 900 + 100)}`,
        scanDate: shipDate,
        scanTime: nowTime,
        trackingId: cleanTracking,
        cleanTracking: cleanTracking,
        orderId: matchedOrder ? matchedOrder.orderId : cleanOrderId,
        cleanOrderId: cleanOrderId,
        carrier: matchedOrder ? matchedOrder.carrier : TrackerDB.detectCarrier(cleanTracking, ''),
        platform: matchedOrder ? matchedOrder.platform : 'ทั่วไป',
        sku: matchedOrder ? matchedOrder.sku : '',
        qty: matchedOrder ? matchedOrder.qty : 1,
        customerName: matchedOrder ? matchedOrder.customerName : '',
        province: matchedOrder ? matchedOrder.province : '',
        followUpStatus: updates.followUpStatus || 'IN_TRANSIT',
        currentHub: updates.currentHub || '',
        followUpNote: updates.followUpNote || '',
        checkedBy: staff,
        checkedAt: `${TrackerDB.formatThaiDateDisplay(TrackerDB.getTodayString())} ${nowTime}`
      });
    }

    await TrackerDB.saveLabelScansToCloud(shipDate, scans, staff);
    await loadFollowUpRangeData();
    if (shipDate === state.activeDate) {
      await refreshActiveDateData(false);
    } else {
      renderFollowUpTab();
    }
    showToast(`✅ บันทึกสถานะติดตามพัสดุ ${cleanTracking || cleanOrderId} เรียบร้อยแล้ว`);
  }

  async function handleApplyBulkFollowUpStatus() {
    if (state.followUpSelectedKeys.size === 0) {
      alert('กรุณาติ๊กเลือกรายการพัสดุในตารางก่อนกดอัปเดตแบบกลุ่มครับ');
      return;
    }

    const newStatus = $('bulk-status-select')?.value || 'IN_TRANSIT';
    const newHub = ($('bulk-hub-input')?.value || '').trim();
    const newNote = ($('bulk-note-input')?.value || '').trim();
    const staff = ($('input-staff-name')?.value || state.config.staffName || 'ฝ่ายติดตามพัสดุ').trim();
    const nowTime = `${TrackerDB.formatThaiDateDisplay(TrackerDB.getTodayString())} ${new Date().toTimeString().slice(0, 5)}`;

    const byDate = new Map();
    const allItems = getFlattenedFollowUpItems();
    allItems.forEach((it) => {
      if (state.followUpSelectedKeys.has(it.uniqueRowKey)) {
        if (!byDate.has(it.shipDate)) byDate.set(it.shipDate, []);
        byDate.get(it.shipDate).push(it);
      }
    });

    for (const [shipDate, items] of byDate.entries()) {
      const dayData = await TrackerDB.syncDailyDataFromCloud(shipDate);
      const scans = [...(dayData.labelScans || [])];

      items.forEach((it) => {
        const idx = scans.findIndex((s) =>
          (it.cleanTracking && s.cleanTracking === it.cleanTracking) ||
          (it.cleanOrderId && s.cleanOrderId === it.cleanOrderId)
        );
        if (idx !== -1) {
          scans[idx] = Object.assign({}, scans[idx], {
            followUpStatus: newStatus,
            currentHub: newHub || scans[idx].currentHub,
            followUpNote: newNote || scans[idx].followUpNote,
            checkedBy: staff,
            checkedAt: nowTime
          });
        } else {
          scans.push({
            id: `FUP-${Date.now()}-${Math.floor(Math.random() * 900 + 100)}`,
            scanDate: shipDate,
            scanTime: new Date().toTimeString().slice(0, 8),
            trackingId: it.trackingId,
            cleanTracking: it.cleanTracking,
            orderId: it.orderId,
            cleanOrderId: it.cleanOrderId,
            carrier: it.carrier,
            platform: it.platform,
            sku: it.sku,
            qty: it.qty,
            customerName: it.customerName,
            province: it.province,
            followUpStatus: newStatus,
            currentHub: newHub,
            followUpNote: newNote,
            checkedBy: staff,
            checkedAt: nowTime
          });
        }
      });

      await TrackerDB.saveLabelScansToCloud(shipDate, scans, staff);
    }

    state.followUpSelectedKeys.clear();
    updateBulkSelectedCount();
    await loadFollowUpRangeData();
    await refreshActiveDateData(false);
    showToast(`⚡ อัปเดตสถานะขนส่งแบบกลุ่มเรียบร้อยแล้ว!`);
  }

  function handleImportCarrierStatusExcel(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const data = new Uint8Array(evt.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        const updates = TrackerDB.parseCarrierStatusRows(rows);

        if (updates.length === 0) {
          alert('ไม่พบคอลัมน์เลขพัสดุ (Tracking) และสถานะในไฟล์ที่เลือก');
          return;
        }

        const staff = ($('input-staff-name')?.value || state.config.staffName || 'ฝ่ายติดตามพัสดุ').trim();
        const nowTime = `${TrackerDB.formatThaiDateDisplay(TrackerDB.getTodayString())} ${new Date().toTimeString().slice(0, 5)}`;

        const dayData = await TrackerDB.syncDailyDataFromCloud(state.activeDate);
        const scans = [...(dayData.labelScans || [])];
        let matchedCount = 0;

        updates.forEach((u) => {
          const idx = scans.findIndex((s) => s.cleanTracking === u.cleanTracking);
          if (idx !== -1) {
            scans[idx] = Object.assign({}, scans[idx], {
              followUpStatus: u.followUpStatus,
              currentHub: u.currentHub || scans[idx].currentHub,
              followUpNote: u.followUpNote || scans[idx].followUpNote,
              checkedBy: staff,
              checkedAt: nowTime
            });
            matchedCount++;
          }
        });

        await TrackerDB.saveLabelScansToCloud(state.activeDate, scans, staff);
        await loadFollowUpRangeData();
        await refreshActiveDateData(false);
        showToast(`📂 อัปเดตสถานะจากไฟล์ขนส่งสำเร็จ ${matchedCount} รายการ!`);
      } catch (err) {
        alert('เกิดข้อผิดพลาดในการอ่านไฟล์: ' + err.message);
      } finally {
        e.target.value = '';
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // ===========================================================================
  // 6. TAB 4: SETTINGS (LINE BOT WEBHOOK & GEMINI API)
  // ===========================================================================

  async function loadCloudConfigAndPopulateSettings() {
    const cfg = await TrackerDB.fetchCloudConfig();
    state.config = cfg;

    const webhookInput = $('cfg-webhook-url');
    if (webhookInput && typeof window !== 'undefined' && window.location.origin.startsWith('http')) {
      webhookInput.value = `${window.location.origin}/api/webhook-line`;
    }

    if ($('cfg-line-channel-id')) $('cfg-line-channel-id').value = cfg.lineChannelId || '';
    if ($('cfg-line-channel-secret')) $('cfg-line-channel-secret').value = cfg.lineChannelSecret || '';
    if ($('cfg-line-access-token')) $('cfg-line-access-token').value = cfg.lineChannelAccessToken || '';
    if ($('cfg-gemini-api-key')) $('cfg-gemini-api-key').value = cfg.geminiApiKey || '';
    if ($('cfg-gemini-model')) $('cfg-gemini-model').value = cfg.geminiModel || 'gemini-flash-latest';
  }

  function setupTab4SettingsControls() {
    $('btn-copy-webhook')?.addEventListener('click', () => {
      const val = $('cfg-webhook-url')?.value || '';
      if (navigator.clipboard && val) {
        navigator.clipboard.writeText(val);
        showToast('📋 คัดลอก Webhook URL เรียบร้อย! นำไปวางใน LINE Developers ได้เลยครับ');
      }
    });

    $('btn-inherit-gemini-key')?.addEventListener('click', async () => {
      const cfg = await TrackerDB.fetchCloudConfig();
      if (cfg.geminiApiKey) {
        if ($('cfg-gemini-api-key')) $('cfg-gemini-api-key').value = cfg.geminiApiKey;
        showToast('🔑 ดึงคีย์ Gemini API จากระบบ QueenCosy เดิมเรียบร้อยแล้ว!');
      } else {
        showToast('ยังไม่มีคีย์ในระบบคลาวด์ กรุณาวาง Gemini API Key ในช่องแล้วกดบันทึก');
      }
    });

    $('btn-save-settings')?.addEventListener('click', async () => {
      const newCfg = {
        lineChannelId: ($('cfg-line-channel-id')?.value || '').trim(),
        lineChannelSecret: ($('cfg-line-channel-secret')?.value || '').trim(),
        lineChannelAccessToken: ($('cfg-line-access-token')?.value || '').trim(),
        geminiApiKey: ($('cfg-gemini-api-key')?.value || '').trim(),
        geminiModel: $('cfg-gemini-model')?.value || 'gemini-flash-latest',
        staffName: ($('input-staff-name')?.value || 'ฝ่ายติดตามพัสดุ').trim()
      };

      const ok = await TrackerDB.saveCloudConfig(newCfg);
      state.config = Object.assign({}, state.config, newCfg);
      if (ok) {
        showToast('✅ บันทึกการตั้งค่า LINE Bot & Gemini API ขึ้น Supabase Cloud สำเร็จ!');
      } else {
        showToast('⚠️ บันทึกการตั้งค่าไว้ในเครื่องเรียบร้อยแล้ว');
      }
    });
  }

  // ===========================================================================
  // 7. IMPORT ORDERS MODAL, SAMPLE DATA & EXCEL REPORT EXPORT
  // ===========================================================================

  function setupImportOrdersModal() {
    const modal = $('modal-import-orders');
    $('btn-open-import-orders')?.addEventListener('click', () => modal?.classList.remove('hidden'));
    $('btn-close-import-modal')?.addEventListener('click', () => modal?.classList.add('hidden'));

    $('input-import-orders-file')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (evt) => {
        try {
          const data = new Uint8Array(evt.target.result);
          const wb = XLSX.read(data, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          const parsedOrders = TrackerDB.parseOrderRows(rows, state.activeDate);

          if (parsedOrders.length === 0) {
            alert('ไม่พบข้อมูลคำสั่งซื้อในไฟล์ที่เลือก กรุณาตรวจสอบหัวตาราง');
            return;
          }

          state.extraOrders = TrackerDB.deduplicateOrderArray([...state.extraOrders, ...parsedOrders]);
          await TrackerDB.saveExtraOrdersToCloud(state.activeDate, state.extraOrders, state.config.staffName);
          modal?.classList.add('hidden');
          await refreshActiveDateData(false);
          showToast(`📂 นำเข้าคำสั่งซื้อสำเร็จ ${parsedOrders.length} รายการ และจับคู่ 3 ทางเรียบร้อย!`);
        } catch (err) {
          alert('อ่านไฟล์ไม่สำเร็จ: ' + err.message);
        } finally {
          e.target.value = '';
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  async function handleLoadSampleData() {
    const sample = TrackerDB.getSampleDataset(state.activeDate);
    state.extraOrders = TrackerDB.deduplicateOrderArray([...state.extraOrders, ...sample.orders]);
    state.qrScans = [...state.qrScans, ...sample.qrScans];
    state.labelScans = TrackerDB.deduplicateLabelScans([...state.labelScans, ...sample.labelScans]);

    for (const ls of sample.labelScans) {
      if (ls.imageDataUrl) {
        await TrackerDB.saveLabelImageToCloud(ls.id, ls.imageDataUrl, ls);
      }
    }

    await TrackerDB.saveExtraOrdersToCloud(state.activeDate, state.extraOrders, state.config.staffName);
    await TrackerDB.saveLabelScansToCloud(state.activeDate, state.labelScans, state.config.staffName);

    recomputeLocalReconciliation();
    renderAll();
    showToast('🧪 โหลดข้อมูลตัวอย่างทดสอบครบทั้ง 3 ทาง (ออเดอร์ + QR + รูปใบลาเบล) เรียบร้อย!');
  }

  async function openPhotoComparisonModal(scanId) {
    const modal = $('modal-photo-viewer');
    const imgEl = $('modal-viewer-img');
    const detailsEl = $('modal-viewer-details');
    if (!modal || !imgEl || !detailsEl) return;

    const item = (state.reconciled.items || []).find((x) => x.labelScanId === scanId || x.id === scanId);
    const scan = (state.labelScans || []).find((s) => s.id === scanId);
    if (!item && !scan) return;

    const d = item || scan;
    if ($('modal-viewer-title')) {
      $('modal-viewer-title').textContent = `ใบปะหน้าพัสดุ: ${d.trackingId || '-'} (${d.carrier || '-'})`;
    }
    if ($('modal-viewer-subtitle')) {
      $('modal-viewer-subtitle').textContent = `Order ID: ${d.orderId || '-'} • วันที่ส่งออก: ${TrackerDB.formatThaiDateDisplay(d.shipDate || state.activeDate)}`;
    }

    imgEl.src = scan?.imageDataUrl || '';
    modal.classList.remove('hidden');

    if (!imgEl.src && scanId) {
      const cloudImg = await TrackerDB.fetchLabelImage(scanId);
      if (cloudImg) imgEl.src = cloudImg;
    }

    const stMeta = TrackerDB.FOLLOW_UP_STATUSES[d.followUpStatus || 'PENDING_PICKUP'] || TrackerDB.FOLLOW_UP_STATUSES.PENDING_PICKUP;

    detailsEl.innerHTML = `
      <div class="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
        <div class="font-bold text-slate-900 text-sm">ผลการรีเช็ค 3 ทาง (3-Way Verification)</div>
        <div>${getThreeWayBadgeHtml(d.threeWayStatus || 'VERIFIED_ALL')}</div>
        <div class="grid grid-cols-2 gap-2 pt-2 text-xs">
          <div class="p-2 rounded-lg bg-white border border-slate-200">
            <span class="text-slate-400 block text-[10px]">ด่านที่ 1: ระบบยิง QR</span>
            <span class="font-bold ${d.hasQr ? 'text-emerald-700' : 'text-rose-600'}">
              ${d.hasQr ? `✅ ยิงแล้ว (${escapeHtml(d.qrScanTime || '')})` : '⚠️ ยังไม่ได้ยิง QR'}
            </span>
          </div>
          <div class="p-2 rounded-lg bg-white border border-slate-200">
            <span class="text-slate-400 block text-[10px]">ด่านที่ 2: รูปใบลาเบล</span>
            <span class="font-bold text-indigo-700">
              📸 ถ่ายแล้ว (${escapeHtml(d.labelScanTime || '')})
            </span>
          </div>
        </div>
      </div>

      <div class="p-3.5 rounded-xl bg-white border border-slate-200 space-y-1.5">
        <div><span class="text-slate-400">เลขพัสดุ (Tracking):</span> <strong class="font-mono text-slate-900">${escapeHtml(d.trackingId || '-')}</strong></div>
        <div><span class="text-slate-400">หมายเลขคำสั่งซื้อ (Order ID):</span> <strong class="font-mono text-slate-900">${escapeHtml(d.orderId || '-')}</strong></div>
        <div><span class="text-slate-400">ขนส่ง / ช่องทาง:</span> <strong>${escapeHtml(d.carrier || '-')} (${escapeHtml(d.platform || '-')})</strong></div>
        <div><span class="text-slate-400">สินค้าในพัสดุ (SKU):</span> <strong class="text-indigo-700">${escapeHtml(d.sku || '-')} (x${d.qty || 1} ชิ้น)</strong></div>
        <div><span class="text-slate-400">ผู้รับ / จังหวัดปลายทาง:</span> <strong>${escapeHtml([d.customerName, d.province].filter(Boolean).join(' • จ.') || '-')}</strong></div>
        <div><span class="text-slate-400">สถานะติดตามขนส่ง:</span> <strong>${escapeHtml(stMeta.label)}</strong> ${d.currentHub ? `(${escapeHtml(d.currentHub)})` : ''}</div>
        ${d.followUpNote ? `<div><span class="text-slate-400">หมายเหตุติดตาม:</span> <span>${escapeHtml(d.followUpNote)}</span></div>` : ''}
      </div>
    `;
  }

  function exportDailyReportExcel(items, fileSuffix) {
    if (typeof XLSX === 'undefined') {
      alert('ไม่พบไลบรารีสร้างไฟล์ Excel (XLSX)');
      return;
    }
    if (!Array.isArray(items) || items.length === 0) {
      alert('ยังไม่มีข้อมูลพัสดุสำหรับส่งออกรายงาน Excel');
      return;
    }

    const statusNameMap = {
      VERIFIED_ALL: 'ครบ 3 ทาง (ออเดอร์+QR+รูปลาเบล)',
      PHOTO_ONLY: 'มีรูปลาเบล แต่ยังไม่ยิง QR',
      QR_ONLY: 'ยิง QR แล้ว แต่ยังไม่มีรูปลาเบล',
      ORDER_PENDING: 'ออเดอร์ค้างแพ็ค/ค้างส่ง',
      UNMATCHED_PHOTO: 'มีรูปถ่าย แต่ไม่พบในออเดอร์'
    };

    const rows = items.map((it, idx) => {
      const fMeta = TrackerDB.FOLLOW_UP_STATUSES[it.followUpStatus || 'PENDING_PICKUP'] || TrackerDB.FOLLOW_UP_STATUSES.PENDING_PICKUP;
      return {
        'ลำดับ': idx + 1,
        'วันที่ส่งออก': it.shipDate || state.activeDate,
        'เลขพัสดุ (Tracking ID)': it.trackingId || '',
        'หมายเลขคำสั่งซื้อ (Order ID)': it.orderId || '',
        'ขนส่ง (Carrier)': it.carrier || '',
        'ช่องทางขาย (Platform)': it.platform || '',
        'ชื่อลูกค้า': it.customerName || '',
        'จังหวัดปลายทาง': it.province || '',
        'รายการสินค้า (SKU / รุ่น-สี)': it.sku || '',
        'จำนวน (ชิ้น)': it.qty || 1,
        'ผลการรีเช็ค 3 ทาง': statusNameMap[it.threeWayStatus] || it.threeWayStatus,
        'สถานะยิง QR': it.hasQr ? `ยิงแล้ว (${it.qrScanTime || ''})` : 'ยังไม่ยิง QR',
        'สถานะรูปใบลาเบล': it.hasPhoto ? `มีรูปแล้ว (${it.labelScanTime || ''})` : 'ยังไม่มีรูป',
        'สถานะติดตามขนส่งล่าสุด': fMeta.label,
        'ศูนย์คัดแยก/จังหวัดปัจจุบัน': it.currentHub || '',
        'หมายเหตุพนักงานติดตามพัสดุ': it.followUpNote || '',
        'ผู้เช็คล่าสุด': it.checkedBy || '',
        'เวลาที่เช็คล่าสุด': it.checkedAt || ''
      };
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
      { wch: 7 },  // ลำดับ
      { wch: 13 }, // วันที่ส่งออก
      { wch: 22 }, // เลขพัสดุ
      { wch: 22 }, // Order ID
      { wch: 20 }, // ขนส่ง
      { wch: 14 }, // ช่องทาง
      { wch: 22 }, // ลูกค้า
      { wch: 16 }, // จังหวัด
      { wch: 34 }, // สินค้า
      { wch: 10 }, // จำนวน
      { wch: 28 }, // รีเช็ค 3 ทาง
      { wch: 18 }, // ยิง QR
      { wch: 18 }, // รูปลาเบล
      { wch: 26 }, // สถานะขนส่ง
      { wch: 22 }, // ศูนย์คัดแยก
      { wch: 34 }, // หมายเหตุ
      { wch: 16 }, // ผู้เช็ค
      { wch: 18 }  // เวลาเช็ค
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Parcel_Label_Tracker');
    XLSX.writeFile(wb, `QueenCosy_Parcel_Tracker_${fileSuffix || state.activeDate}.xlsx`);
  }
})();
