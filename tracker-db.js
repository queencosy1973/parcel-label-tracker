/**
 * QueenCosy Parcel Label AI Tracker & 3-Way Re-Check Database Engine (tracker-db.js)
 * Works in both Browser (window.TrackerDB) and Node.js Serverless (module.exports)
 *
 * Features:
 * 1. Read-Only integration with daily-parcel-checker (QC_PARCEL_DATA_<YYYY-MM-DD>)
 * 2. Isolated Cloud Namespaces:
 *    - QC_LABEL_CONFIG_V1          (source: QC_LABEL_CONFIG)
 *    - QC_LABEL_SCAN_<YYYY-MM-DD>  (source: QC_LABEL_SCAN)
 *    - QC_LABEL_ORDERS_<YYYY-MM-DD>(source: QC_LABEL_ORDERS)
 *    - QC_LABEL_IMG_<scanId>       (source: QC_LABEL_IMAGE) - Separated from metadata for < 0.5s sync
 * 3. Strict 1 Tracking = 1 Record per day deduplication (deduplicateLabelScans)
 * 4. 3-Way Reconciliation Engine (reconcileThreeWayStatus):
 *    - VERIFIED_ALL    (ครบ 3 ทาง: มีออเดอร์ + ยิง QR แล้ว + มีรูปถ่ายใบลาเบล)
 *    - PHOTO_ONLY      (มีรูปถ่ายลาเบล แต่ยังไม่ยิง QR)
 *    - QR_ONLY         (ยิง QR แล้ว แต่ยังไม่มีรูปถ่ายลาเบล)
 *    - ORDER_PENDING   (มีออเดอร์ แต่ยังไม่ยิง QR และยังไม่มีรูปถ่าย)
 *    - UNMATCHED_PHOTO (มีรูปถ่ายลาเบล แต่ไม่พบในไฟล์คำสั่งซื้อ)
 * 5. Gemini Vision AI OCR for Thai Shipping Labels (SPX, Flash, J&T, KEX, LEX, BEST, Thailand Post)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TrackerDB = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_SUPABASE_URL = 'https://yercmidyvfetvbbrewlf.supabase.co';
  const DEFAULT_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InllcmNtaWR5dmZldHZiYnJld2xmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2MTA4MzUsImV4cCI6MjEwNDE4NjgzNX0.7tGbXNoogdLh6UQOJBJe9MABmY7W5J1aixPLJSXGSGk';
  const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';

  const STORAGE_KEYS = {
    CONFIG: 'qc_label_tracker_config_v1',
    DAILY_CACHE_PREFIX: 'qc_label_tracker_daily_v1_'
  };

  // Follow-up Delivery Status Definitions (for Tab 3 Next-Day Follow-up Staff)
  const FOLLOW_UP_STATUSES = {
    PENDING_PICKUP: {
      code: 'PENDING_PICKUP',
      label: '⏳ รอขนส่งรับเข้าระบบ',
      shortLabel: 'รอเข้าระบบ',
      badgeClass: 'bg-slate-100 text-slate-700 border-slate-300'
    },
    IN_TRANSIT: {
      code: 'IN_TRANSIT',
      label: '🚚 ส่งออกแล้ว / กำลังเดินทาง',
      shortLabel: 'กำลังเดินทาง',
      badgeClass: 'bg-sky-50 text-sky-700 border-sky-300'
    },
    OUT_FOR_DELIVERY: {
      code: 'OUT_FOR_DELIVERY',
      label: '📦 กำลังนำจ่ายปลายทาง',
      shortLabel: 'กำลังนำจ่าย',
      badgeClass: 'bg-indigo-50 text-indigo-700 border-indigo-300'
    },
    DELIVERED: {
      code: 'DELIVERED',
      label: '✅ จัดส่งสำเร็จ',
      shortLabel: 'จัดส่งสำเร็จ',
      badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-300'
    },
    ISSUE: {
      code: 'ISSUE',
      label: '🚨 ติดปัญหา / พัสดุค้าง / ต้องติดตามด่วน',
      shortLabel: 'ติดปัญหา/ตามด่วน',
      badgeClass: 'bg-rose-100 text-rose-800 border-rose-400'
    },
    RETURNED: {
      code: 'RETURNED',
      label: '↩️ ตีกลับ',
      shortLabel: 'พัสดุตีกลับ',
      badgeClass: 'bg-amber-100 text-amber-900 border-amber-400'
    }
  };

  // QueenCosy Sofa & Furniture Master SKU Catalog for smart product matching
  const QUEENCOSY_SKU_CATALOG = [
    { code: 'mn', name: 'โซฟาตัวแอลมินิมอล (MN)', keywords: ['mn', 'mnh', 'mncf', 'mnn', 'mnpy', 'แอลมินิมอล', 'ตัวแอล'] },
    { code: 'ln3', name: 'โซฟา 3 ที่นั่งกระดุมวางแก้ว (LN3)', keywords: ['ln3', 'กระดุมวางแก้ว'] },
    { code: 'rcs', name: 'โซฟาเบดปรับนอนเรียบ (RCS)', keywords: ['rcs', 'ปรับนอนเรียบ', 'เบดเรียบ'] },
    { code: 'rc', name: 'โซฟาเบดปรับนอนดึงกระดุม (RC)', keywords: ['rc', 'rcii', 'rch', 'rcn', 'rcw', 'เบดปรับนอน'] },
    { code: 'bs3s', name: 'โซฟา 3 ที่นั่งเรียบมีแขน (BS3S)', keywords: ['bs3s', '3ที่นั่งเรียบมีแขน'] },
    { code: 'bs3', name: 'โซฟา 3 ที่นั่งท้าวแขน (BS3)', keywords: ['bs3', '3ที่นั่งท้าวแขน', '311'] },
    { code: 'rss', name: 'โซฟาเบดหัวกระดกเรียบ (RSS)', keywords: ['rss', 'หัวกระดกเรียบ'] },
    { code: 'rs', name: 'โซฟาเบดหัวกระดก (RS)', keywords: ['rs', 'rsii', 'rsh', 'rsn', 'rsw', 'หัวกระดก'] },
    { code: 'lz', name: 'โซฟา 3 ที่นั่งเบาะกระดุมเล็ก (LZ)', keywords: ['lz', 'กระดุมเล็ก'] },
    { code: 'lu3', name: 'โซฟา 3 ที่นั่งวางแก้วเรียบ (LU3)', keywords: ['lu3', 'วางแก้วเรียบ'] },
    { code: 'bs2', name: 'โซฟา 2 ที่นั่งท้าวแขน (BS2)', keywords: ['bs2', '2ที่นั่งท้าวแขน'] },
    { code: 'cs3', name: 'โซฟา 3 ที่นั่งเรียบเบาะใหญ่ (CS3)', keywords: ['cs3', 'เรียบเบาะใหญ่ 3'] },
    { code: 'cs2', name: 'โซฟา 2 ที่นั่งเรียบเบาะใหญ่ (CS2)', keywords: ['cs2', 'เรียบเบาะใหญ่ 2'] },
    { code: 'cu', name: 'เก้าอี้สตูลเหลี่ยม (CU)', keywords: ['cu', 'สตูลเหลี่ยม', 'สตูลสี่เหลี่ยม'] },
    { code: 'cl', name: 'เก้าอี้สตูลกลม (CL)', keywords: ['cl', 'สตูลกลม'] },
    { code: 'rv3', name: 'ผ้าเปลี่ยนผิวโซฟา 3 ที่นั่ง (RV3)', keywords: ['rv3', 'ผ้าคลุม 3'] },
    { code: 'rv2', name: 'ผ้าเปลี่ยนผิวโซฟา 2 ที่นั่ง (RV2)', keywords: ['rv2', 'ผ้าคลุม 2'] },
    { code: 'pl', name: 'หมอนอิง (PL)', keywords: ['pl', 'plcf', 'plh', 'pln', 'plpy', 'หมอนอิง'] }
  ];

  // In-memory Image Cache for ultra-fast repeated previews
  const memoryImageCache = new Map();

  // ===========================================================================
  // 1. DATE, TRACKING & CARRIER UTILITIES
  // ===========================================================================

  function getTodayString() {
    // Use Thailand timezone (UTC+7) safely in both Browser and Vercel Node.js
    const now = new Date(Date.now() + 7 * 3600 * 1000);
    return now.toISOString().slice(0, 10);
  }

  function adjustDateString(dateStr, offsetDays) {
    const base = dateStr || getTodayString();
    const parts = base.split('-').map(Number);
    const dt = new Date(Date.UTC(parts[0], (parts[1] || 1) - 1, (parts[2] || 1) + offsetDays));
    return dt.toISOString().slice(0, 10);
  }

  function formatThaiDateDisplay(isoDateStr) {
    if (!isoDateStr) return '-';
    const parts = String(isoDateStr).slice(0, 10).split('-');
    if (parts.length < 3) return isoDateStr;
    const y = parseInt(parts[0], 10);
    const beYear = y < 2400 ? y + 543 : y;
    const m = parseInt(parts[1], 10) - 1;
    const d = parseInt(parts[2], 10);
    const thaiMonths = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
    return `${d} ${thaiMonths[m] || ''} ${beYear}`;
  }

  function normalizeTracking(str) {
    if (!str) return '';
    return String(str)
      .replace(/[\s\u00A0\u200B-\u200D\uFEFF\-]/g, '')
      .toUpperCase();
  }

  function normalizeOrderId(str) {
    if (!str) return '';
    return String(str)
      .replace(/[\s\u00A0\u200B-\u200D\uFEFF]/g, '')
      .toUpperCase();
  }

  function detectCarrier(rawTracking, explicitCarrier) {
    if (explicitCarrier) {
      const exp = String(explicitCarrier).trim();
      const upper = exp.toUpperCase();
      if (upper.includes('SPX') || upper.includes('SHOPEE')) return 'Shopee Xpress (SPX)';
      if (upper.includes('FLASH')) return 'Flash Express';
      if (upper.includes('J&T') || upper.includes('JNT') || upper.includes('JT')) return 'J&T Express';
      if (upper.includes('KEX') || upper.includes('KERRY')) return 'KEX Express';
      if (upper.includes('LEX') || upper.includes('LAZADA')) return 'LEX (Lazada Express)';
      if (upper.includes('BEST')) return 'BEST Express';
      if (upper.includes('POST') || upper.includes('ไปรษณีย์') || upper.includes('EMS')) return 'ไปรษณีย์ไทย';
      if (upper.includes('DHL')) return 'DHL eCommerce';
      if (exp && !/^\d+$/.test(exp) && !exp.startsWith('Qs-') && exp !== '1') {
        return exp;
      }
    }

    const clean = normalizeTracking(rawTracking);
    if (!clean) return 'ไม่ระบุขนส่ง';
    if (/^SPXTH/i.test(clean)) return 'Shopee Xpress (SPX)';
    if (/^(THT|TH\d{9,}|TH[A-Z0-9]{8,})/i.test(clean)) return 'Flash Express';
    if (/^(66\d{12}|\d{14})$/.test(clean) && clean.startsWith('66')) return 'BEST Express';
    if (/^(82\d{10}|61\d{10}|7\d{11}|JNT|JT)/i.test(clean)) return 'J&T Express';
    if (/^(KER|KEX|SDOF|SHP\d+)/i.test(clean)) return 'KEX Express';
    if (/^(LEX|LXAD)/i.test(clean)) return 'LEX (Lazada Express)';
    if (/^(E[A-Z]\d{9}TH|R[A-Z]\d{9}TH|P[A-Z]\d{9}TH|JA\d+TH)/i.test(clean)) return 'ไปรษณีย์ไทย';
    return 'Flash Express';
  }

  function detectPlatform(orderId, explicitPlatform, rawCarrier) {
    if (explicitPlatform) {
      const p = String(explicitPlatform).trim();
      const u = p.toUpperCase();
      if (u.includes('SHOPEE')) return 'Shopee';
      if (u.includes('TIKTOK')) return 'TikTok Shop';
      if (u.includes('LAZADA')) return 'Lazada';
      if (u.includes('LINE') || u.includes('FACEBOOK') || u.includes('FB') || u.includes('เพจ')) return 'เพจร้าน / LINE';
      if (p) return p;
    }
    const cleanOrd = normalizeOrderId(orderId);
    if (/^\d{18,20}$/.test(cleanOrd) && cleanOrd.startsWith('5')) return 'TikTok Shop';
    if (/^\d{6}[A-Z0-9]{8}$/.test(cleanOrd)) return 'Shopee';
    if (/^\d{15,16}$/.test(cleanOrd)) return 'Lazada';
    const c = String(rawCarrier || '').toUpperCase();
    if (c.includes('SPX') || c.includes('SHOPEE')) return 'Shopee';
    if (c.includes('LEX') || c.includes('LAZADA')) return 'Lazada';
    return 'ทั่วไป';
  }

  function getCarrierTrackingUrl(carrier, trackingId) {
    const clean = normalizeTracking(trackingId);
    const c = String(carrier || '').toUpperCase();

    if (c.includes('SPX') || c.includes('SHOPEE') || clean.startsWith('SPXTH')) {
      return `https://spx.co.th/th/track?${encodeURIComponent(clean)}`;
    }
    if (c.includes('FLASH') || clean.startsWith('TH')) {
      return `https://www.flashexpress.co.th/fle/tracking?se=${encodeURIComponent(clean)}`;
    }
    if (c.includes('J&T') || c.includes('JNT') || c.includes('JT')) {
      return `https://www.jtexpress.co.th/service/track?waybillNo=${encodeURIComponent(clean)}`;
    }
    if (c.includes('KEX') || c.includes('KERRY')) {
      return `https://th.kex-express.com/th/track/?track=${encodeURIComponent(clean)}`;
    }
    if (c.includes('BEST')) {
      return `https://www.best-inc.co.th/track?bills=${encodeURIComponent(clean)}`;
    }
    if (c.includes('LEX') || c.includes('LAZADA')) {
      return `https://tracker.lel.asia/tracker?trackingNumber=${encodeURIComponent(clean)}`;
    }
    if (c.includes('ไปรษณีย์') || c.includes('POST') || c.includes('EMS')) {
      return `https://track.thailandpost.co.th/?trackNumber=${encodeURIComponent(clean)}`;
    }
    return `https://www.google.com/search?q=${encodeURIComponent((carrier || 'เช็คพัสดุ') + ' ' + clean)}`;
  }

  // ===========================================================================
  // 2. DEDUPLICATION & 3-WAY RECONCILIATION ENGINE
  // ===========================================================================

  function deduplicateOrderArray(arr) {
    if (!Array.isArray(arr)) return [];
    const byKey = new Map();

    arr.forEach((o) => {
      if (!o) return;
      const cleanTrk = normalizeTracking(o.cleanTracking || o.trackingId || '');
      const cleanOrd = normalizeOrderId(o.orderId || '');
      const sku = String(o.sku || '').trim();
      if (!cleanTrk && !cleanOrd && !sku) return;

      const key = cleanTrk
        ? `TRK:${cleanTrk}|${sku}`
        : `ORD:${cleanOrd}|${sku}`;

      if (!byKey.has(key)) {
        byKey.set(key, Object.assign({}, o, {
          cleanTracking: cleanTrk,
          trackingId: o.trackingId ? String(o.trackingId).trim() : cleanTrk,
          orderId: o.orderId ? String(o.orderId).trim() : '',
          carrier: detectCarrier(cleanTrk, o.carrier),
          platform: detectPlatform(o.orderId, o.platform, o.carrier)
        }));
      } else {
        const existing = byKey.get(key);
        if (!existing.cleanTracking && cleanTrk) {
          existing.cleanTracking = cleanTrk;
          existing.trackingId = o.trackingId || cleanTrk;
        }
        if (!existing.orderId && o.orderId) existing.orderId = String(o.orderId).trim();
        if (!existing.customerName && o.customerName) existing.customerName = o.customerName;
        if (!existing.province && o.province) existing.province = o.province;
        if (!existing.sku && o.sku) existing.sku = o.sku;
        if (o.isCancelled !== undefined) existing.isCancelled = o.isCancelled;
      }
    });

    return Array.from(byKey.values());
  }

  /**
   * Enforces strict rule: 1 Tracking Number (or Order ID if tracking unreadable) = 1 Record per day.
   * If a parcel label is photographed again on the same day, updates the existing entry in-place
   * while preserving existing ID and follow-up tracking notes unless newer data is provided.
   */
  function deduplicateLabelScans(scans) {
    if (!Array.isArray(scans)) return [];
    const mapByKey = new Map();

    scans.forEach((raw) => {
      if (!raw) return;
      const cleanTrk = normalizeTracking(raw.cleanTracking || raw.trackingId || '');
      const cleanOrd = normalizeOrderId(raw.orderId || '');
      const fallbackId = String(raw.id || '').trim();

      const dedupKey = cleanTrk
        ? `TRK:${cleanTrk}`
        : (cleanOrd ? `ORD:${cleanOrd}` : `ID:${fallbackId || Math.random()}`);

      const normalizedItem = Object.assign({}, raw, {
        id: raw.id || `LBL-${Date.now()}-${Math.floor(Math.random() * 900 + 100)}`,
        trackingId: raw.trackingId ? String(raw.trackingId).trim() : cleanTrk,
        cleanTracking: cleanTrk,
        orderId: raw.orderId ? String(raw.orderId).trim() : '',
        cleanOrderId: cleanOrd,
        carrier: detectCarrier(cleanTrk, raw.carrier),
        platform: detectPlatform(raw.orderId, raw.platform, raw.carrier),
        sku: String(raw.sku || raw.productName || '').trim(),
        productName: String(raw.productName || raw.sku || '').trim(),
        qty: parseInt(raw.qty, 10) || 1,
        customerName: String(raw.customerName || '').trim(),
        province: String(raw.province || '').trim(),
        followUpStatus: raw.followUpStatus || 'PENDING_PICKUP',
        currentHub: String(raw.currentHub || '').trim(),
        followUpNote: String(raw.followUpNote || '').trim(),
        checkedBy: String(raw.checkedBy || '').trim(),
        checkedAt: raw.checkedAt || ''
      });

      if (!mapByKey.has(dedupKey)) {
        mapByKey.set(dedupKey, normalizedItem);
      } else {
        const prev = mapByKey.get(dedupKey);
        const merged = Object.assign({}, prev, normalizedItem, {
          // Keep the latest scan ID if it has a new image, or keep existing if updating metadata
          id: normalizedItem.hasCloudImage || normalizedItem.imageDataUrl ? normalizedItem.id : prev.id,
          trackingId: normalizedItem.trackingId || prev.trackingId,
          cleanTracking: cleanTrk || prev.cleanTracking,
          orderId: normalizedItem.orderId || prev.orderId,
          cleanOrderId: cleanOrd || prev.cleanOrderId,
          carrier: normalizedItem.carrier !== 'ไม่ระบุขนส่ง' ? normalizedItem.carrier : prev.carrier,
          platform: normalizedItem.platform !== 'ทั่วไป' ? normalizedItem.platform : prev.platform,
          sku: normalizedItem.sku || prev.sku,
          productName: normalizedItem.productName || prev.productName,
          qty: normalizedItem.qty || prev.qty || 1,
          customerName: normalizedItem.customerName || prev.customerName,
          province: normalizedItem.province || prev.province,
          // Preserve follow-up progress if the new item is just a re-photo with default PENDING_PICKUP
          followUpStatus:
            normalizedItem.followUpStatus && normalizedItem.followUpStatus !== 'PENDING_PICKUP'
              ? normalizedItem.followUpStatus
              : (prev.followUpStatus || 'PENDING_PICKUP'),
          currentHub: normalizedItem.currentHub || prev.currentHub || '',
          followUpNote: normalizedItem.followUpNote || prev.followUpNote || '',
          checkedBy: normalizedItem.checkedBy || prev.checkedBy || '',
          checkedAt: normalizedItem.checkedAt || prev.checkedAt || '',
          hasCloudImage: Boolean(normalizedItem.hasCloudImage || prev.hasCloudImage || normalizedItem.imageDataUrl || prev.imageDataUrl),
          imageDataUrl: normalizedItem.imageDataUrl || prev.imageDataUrl || '',
          updatedAt: normalizedItem.updatedAt || new Date().toISOString()
        });
        mapByKey.set(dedupKey, merged);
      }
    });

    return Array.from(mapByKey.values());
  }

  /**
   * 3-Way Reconciliation Engine:
   * Compares:
   *  1. orders     (from daily-parcel-checker + direct Excel imports)
   *  2. qrScans    (from daily-parcel-checker barcode gun / mobile QR scanner)
   *  3. labelScans (from LINE Bot photo AI + Web AI label uploads)
   *
   * Classifies each parcel into:
   *  - VERIFIED_ALL    (ครบ 3 ทาง: มีออเดอร์ + ยิง QR แล้ว + มีรูปถ่ายใบลาเบล)
   *  - PHOTO_ONLY      (มีรูปถ่ายลาเบล แต่ยังไม่ยิง QR)
   *  - QR_ONLY         (ยิง QR แล้ว แต่ยังไม่มีรูปถ่ายลาเบล)
   *  - ORDER_PENDING   (มีออเดอร์ แต่ยังไม่ยิง QR และยังไม่มีรูปถ่าย)
   *  - UNMATCHED_PHOTO (มีรูปถ่ายลาเบล แต่ไม่พบในไฟล์คำสั่งซื้อ)
   */
  function reconcileThreeWayStatus(orders = [], qrScans = [], labelScans = [], date = '') {
    const cleanOrders = deduplicateOrderArray(orders);
    const cleanLabels = deduplicateLabelScans(labelScans);
    const safeQrScans = Array.isArray(qrScans) ? qrScans.filter((s) => !s.isBlocked) : [];

    // 1. Index QR Scans by cleanTracking and by matchedOrderId
    const qrByTracking = new Map();
    const qrByOrderId = new Map();
    safeQrScans.forEach((qs) => {
      if (!qs) return;
      const trk = normalizeTracking(qs.cleanTracking || qs.trackingId || '');
      const ord = normalizeOrderId(qs.matchedOrderId || '');
      if (trk && !qrByTracking.has(trk)) qrByTracking.set(trk, qs);
      if (ord && !qrByOrderId.has(ord)) qrByOrderId.set(ord, qs);
    });

    // 2. Index Label Photo Scans by cleanTracking and by cleanOrderId
    const labelByTracking = new Map();
    const labelByOrderId = new Map();
    cleanLabels.forEach((ls) => {
      const trk = normalizeTracking(ls.cleanTracking || ls.trackingId || '');
      const ord = normalizeOrderId(ls.cleanOrderId || ls.orderId || '');
      if (trk && !labelByTracking.has(trk)) labelByTracking.set(trk, ls);
      if (ord && !labelByOrderId.has(ord)) labelByOrderId.set(ord, ls);
    });

    // 3. Consolidate orders by parcel (Tracking ID or Order ID) so 1 parcel = 1 row in dashboard
    //    (If an order has multiple SKUs in the same parcel box, combine SKU text & sum qty)
    const parcelGroups = new Map();
    cleanOrders.forEach((o) => {
      let trk = normalizeTracking(o.cleanTracking || o.trackingId || '');
      const ord = normalizeOrderId(o.orderId || '');

      // If order doesn't have tracking yet, check if a label scan or QR scan matched by Order ID provides tracking!
      if (!trk && ord) {
        const matchedLbl = labelByOrderId.get(ord);
        if (matchedLbl && matchedLbl.cleanTracking) {
          trk = matchedLbl.cleanTracking;
        } else {
          const matchedQr = qrByOrderId.get(ord);
          if (matchedQr) {
            trk = normalizeTracking(matchedQr.cleanTracking || matchedQr.trackingId || '');
          }
        }
      }

      const groupKey = trk ? `TRK:${trk}` : `ORD:${ord || o.id || Math.random()}`;
      if (!parcelGroups.has(groupKey)) {
        parcelGroups.set(groupKey, {
          key: groupKey,
          shipDate: o.shipDate || date || getTodayString(),
          orderId: o.orderId || '',
          cleanOrderId: ord,
          trackingId: o.trackingId || trk || '',
          cleanTracking: trk,
          carrier: detectCarrier(trk, o.carrier),
          platform: detectPlatform(o.orderId, o.platform, o.carrier),
          skuList: o.sku ? [String(o.sku).trim()] : [],
          qty: parseInt(o.qty, 10) || 1,
          customerName: o.customerName || '',
          province: o.province || '',
          packer: o.packer || '',
          isCancelled: Boolean(o.isCancelled || (o.orderStatus && (String(o.orderStatus).includes('ยกเลิก') || String(o.orderStatus).toLowerCase().includes('cancel')))),
          rawOrders: [o]
        });
      } else {
        const g = parcelGroups.get(groupKey);
        const skuStr = o.sku ? String(o.sku).trim() : '';
        if (skuStr && !g.skuList.includes(skuStr)) {
          g.skuList.push(skuStr);
        }
        g.qty += (parseInt(o.qty, 10) || 1);
        if (!g.orderId && o.orderId) {
          g.orderId = o.orderId;
          g.cleanOrderId = ord;
        }
        if (!g.customerName && o.customerName) g.customerName = o.customerName;
        if (!g.province && o.province) g.province = o.province;
        g.rawOrders.push(o);
      }
    });

    const usedLabelIds = new Set();
    const reconciledItems = [];

    // 4. Evaluate 3-Way Status for each Order Parcel
    parcelGroups.forEach((group) => {
      const trk = group.cleanTracking;
      const ord = group.cleanOrderId;

      const qrScan = (trk && qrByTracking.get(trk)) || (ord && qrByOrderId.get(ord)) || null;
      const labelScan = (trk && labelByTracking.get(trk)) || (ord && labelByOrderId.get(ord)) || null;

      if (labelScan && labelScan.id) {
        usedLabelIds.add(labelScan.id);
      }

      const hasOrder = true;
      const hasQr = Boolean(qrScan);
      const hasPhoto = Boolean(labelScan);

      let threeWayStatus = 'ORDER_PENDING';
      if (hasQr && hasPhoto) {
        threeWayStatus = 'VERIFIED_ALL';
      } else if (hasPhoto && !hasQr) {
        threeWayStatus = 'PHOTO_ONLY';
      } else if (hasQr && !hasPhoto) {
        threeWayStatus = 'QR_ONLY';
      } else {
        threeWayStatus = 'ORDER_PENDING';
      }

      const effectiveTracking = group.trackingId || (labelScan ? labelScan.trackingId : '') || (qrScan ? qrScan.trackingId : '');
      const effectiveCleanTracking = normalizeTracking(effectiveTracking);
      const effectiveOrderId = group.orderId || (labelScan ? labelScan.orderId : '') || (qrScan ? qrScan.matchedOrderId : '');
      const effectiveCarrier = detectCarrier(effectiveCleanTracking, group.carrier !== 'ไม่ระบุขนส่ง' ? group.carrier : (labelScan ? labelScan.carrier : ''));
      const effectivePlatform = detectPlatform(effectiveOrderId, group.platform !== 'ทั่วไป' ? group.platform : (labelScan ? labelScan.platform : ''), effectiveCarrier);
      const combinedSku = group.skuList.length > 0 ? group.skuList.join(' + ') : (labelScan ? labelScan.sku : '-');

      reconciledItems.push({
        id: labelScan ? labelScan.id : `ITEM-${effectiveCleanTracking || effectiveOrderId || Math.random().toString(36).slice(2, 8)}`,
        shipDate: group.shipDate,
        orderId: effectiveOrderId,
        cleanOrderId: normalizeOrderId(effectiveOrderId),
        trackingId: effectiveTracking,
        cleanTracking: effectiveCleanTracking,
        carrier: effectiveCarrier,
        platform: effectivePlatform,
        sku: combinedSku,
        qty: group.qty || (labelScan ? labelScan.qty : 1),
        customerName: group.customerName || (labelScan ? labelScan.customerName : ''),
        province: group.province || (labelScan ? labelScan.province : ''),
        isCancelled: group.isCancelled,

        // 3-Way Check Flags
        threeWayStatus: threeWayStatus,
        hasOrder: hasOrder,
        hasQr: hasQr,
        hasPhoto: hasPhoto,

        // QR Scan Details
        qrScanTime: qrScan ? (qrScan.scanTime || '') : '',
        qrScanner: qrScan ? (qrScan.scanner || '') : '',
        qrSource: qrScan ? (qrScan.source || '') : '',

        // Label Photo Scan Details
        labelScanId: labelScan ? labelScan.id : '',
        labelScanTime: labelScan ? (labelScan.scanTime || '') : '',
        labelSource: labelScan ? (labelScan.sourceChannel || 'WEB') : '',
        labelSender: labelScan ? (labelScan.senderName || '') : '',
        hasCloudImage: labelScan ? Boolean(labelScan.hasCloudImage || labelScan.imageDataUrl) : false,
        imageDataUrl: labelScan ? (labelScan.imageDataUrl || '') : '',
        aiConfidence: labelScan ? (labelScan.confidence || 'HIGH') : '',

        // Next-Day Follow-up Tracking Details
        followUpStatus: labelScan && labelScan.followUpStatus ? labelScan.followUpStatus : 'PENDING_PICKUP',
        currentHub: labelScan ? (labelScan.currentHub || '') : '',
        followUpNote: labelScan ? (labelScan.followUpNote || '') : '',
        checkedBy: labelScan ? (labelScan.checkedBy || '') : '',
        checkedAt: labelScan ? (labelScan.checkedAt || '') : ''
      });
    });

    // 5. Append any Label Photo Scans that were NOT matched to any Order (UNMATCHED_PHOTO)
    //    Also check if there are QR scans without orders that match these label photos!
    cleanLabels.forEach((ls) => {
      if (usedLabelIds.has(ls.id)) return;
      const trk = ls.cleanTracking;
      const ord = ls.cleanOrderId;
      const qrScan = (trk && qrByTracking.get(trk)) || (ord && qrByOrderId.get(ord)) || null;

      reconciledItems.push({
        id: ls.id,
        shipDate: ls.scanDate || date || getTodayString(),
        orderId: ls.orderId || (qrScan ? qrScan.matchedOrderId : '') || '',
        cleanOrderId: ord,
        trackingId: ls.trackingId || ls.cleanTracking || '',
        cleanTracking: trk,
        carrier: detectCarrier(trk, ls.carrier),
        platform: detectPlatform(ls.orderId, ls.platform, ls.carrier),
        sku: ls.sku || ls.productName || (qrScan ? qrScan.matchedSku : '') || 'รอนำเข้าข้อมูลออเดอร์',
        qty: ls.qty || (qrScan ? parseInt(qrScan.matchedQty, 10) : 1) || 1,
        customerName: ls.customerName || '',
        province: ls.province || '',
        isCancelled: false,

        threeWayStatus: 'UNMATCHED_PHOTO',
        hasOrder: false,
        hasQr: Boolean(qrScan),
        hasPhoto: true,

        qrScanTime: qrScan ? (qrScan.scanTime || '') : '',
        qrScanner: qrScan ? (qrScan.scanner || '') : '',
        qrSource: qrScan ? (qrScan.source || '') : '',

        labelScanId: ls.id,
        labelScanTime: ls.scanTime || '',
        labelSource: ls.sourceChannel || 'LINE_GROUP',
        labelSender: ls.senderName || '',
        hasCloudImage: Boolean(ls.hasCloudImage || ls.imageDataUrl),
        imageDataUrl: ls.imageDataUrl || '',
        aiConfidence: ls.confidence || 'HIGH',

        followUpStatus: ls.followUpStatus || 'PENDING_PICKUP',
        currentHub: ls.currentHub || '',
        followUpNote: ls.followUpNote || '',
        checkedBy: ls.checkedBy || '',
        checkedAt: ls.checkedAt || ''
      });
    });

    // 6. Also check if there are QR scans that have neither an Order nor a Label Photo yet
    //    (e.g., warehouse scanned QR before importing orders) -> show as QR_ONLY so nothing is hidden!
    const existingTrackingsInReconciled = new Set(reconciledItems.map((i) => i.cleanTracking).filter(Boolean));
    safeQrScans.forEach((qs) => {
      const trk = normalizeTracking(qs.cleanTracking || qs.trackingId || '');
      if (!trk || existingTrackingsInReconciled.has(trk)) return;
      existingTrackingsInReconciled.add(trk);

      reconciledItems.push({
        id: `QRONLY-${trk}`,
        shipDate: qs.scanDate || date || getTodayString(),
        orderId: qs.matchedOrderId || '',
        cleanOrderId: normalizeOrderId(qs.matchedOrderId || ''),
        trackingId: qs.trackingId || trk,
        cleanTracking: trk,
        carrier: detectCarrier(trk, qs.matchedCarrier),
        platform: detectPlatform(qs.matchedOrderId, '', qs.matchedCarrier),
        sku: qs.matchedSku || 'สแกน QR แล้ว (รอนำเข้าออเดอร์)',
        qty: parseInt(qs.matchedQty, 10) || 1,
        customerName: '',
        province: '',
        isCancelled: false,

        threeWayStatus: 'QR_ONLY',
        hasOrder: false,
        hasQr: true,
        hasPhoto: false,

        qrScanTime: qs.scanTime || '',
        qrScanner: qs.scanner || '',
        qrSource: qs.source || '',

        labelScanId: '',
        labelScanTime: '',
        labelSource: '',
        labelSender: '',
        hasCloudImage: false,
        imageDataUrl: '',
        aiConfidence: '',

        followUpStatus: 'PENDING_PICKUP',
        currentHub: '',
        followUpNote: '',
        checkedBy: '',
        checkedAt: ''
      });
    });

    // 7. Compute Summary KPIs
    let totalOrders = 0;
    let totalUnits = 0;
    let qrScannedCount = 0;
    let labelPhotoCount = 0;
    let verifiedAllCount = 0;
    let photoOnlyCount = 0;
    let qrOnlyCount = 0;
    let orderPendingCount = 0;
    let unmatchedPhotoCount = 0;

    const followUpCounts = {
      PENDING_PICKUP: 0,
      IN_TRANSIT: 0,
      OUT_FOR_DELIVERY: 0,
      DELIVERED: 0,
      ISSUE: 0,
      RETURNED: 0
    };

    reconciledItems.forEach((item) => {
      if (item.hasOrder) {
        totalOrders++;
        totalUnits += (parseInt(item.qty, 10) || 1);
      }
      if (item.hasQr) qrScannedCount++;
      if (item.hasPhoto) labelPhotoCount++;

      if (item.threeWayStatus === 'VERIFIED_ALL') verifiedAllCount++;
      else if (item.threeWayStatus === 'PHOTO_ONLY') photoOnlyCount++;
      else if (item.threeWayStatus === 'QR_ONLY') qrOnlyCount++;
      else if (item.threeWayStatus === 'ORDER_PENDING') orderPendingCount++;
      else if (item.threeWayStatus === 'UNMATCHED_PHOTO') unmatchedPhotoCount++;

      const fStatus = item.followUpStatus || 'PENDING_PICKUP';
      if (followUpCounts[fStatus] !== undefined) {
        followUpCounts[fStatus]++;
      } else {
        followUpCounts.PENDING_PICKUP++;
      }
    });

    const issuesToFollowCount = photoOnlyCount + qrOnlyCount + orderPendingCount + unmatchedPhotoCount;

    return {
      date: date || getTodayString(),
      items: reconciledItems,
      summary: {
        totalItems: reconciledItems.length,
        totalOrders,
        totalUnits,
        qrScannedCount,
        labelPhotoCount,
        verifiedAllCount,
        photoOnlyCount,
        qrOnlyCount,
        orderPendingCount,
        unmatchedPhotoCount,
        issuesToFollowCount,
        followUpCounts
      }
    };
  }

  // ===========================================================================
  // 3. GEMINI VISION AI OCR FOR SHIPPING LABELS ON REAL PARCELS
  // ===========================================================================

  function buildParcelLabelPrompt() {
    const skuHintList = QUEENCOSY_SKU_CATALOG.map((s) => `${s.code.toUpperCase()} (${s.name})`).join(', ');
    return `คุณคือระบบ AI ตรวจสอบใบปะหน้าพัสดุ (Shipping Label OCR) ของโรงงานผลิตโซฟาและเฟอร์นิเจอร์ "QueenCosy"
หน้าที่ของคุณคืออ่านรูปถ่าย "ใบปะหน้าพัสดุที่ติดอยู่บนตัวสินค้าจริง" แล้วสกัดข้อมูลสำคัญออกมาเป็น JSON ที่แม่นยำ 100%

รหัสสินค้าหลักของโรงงาน QueenCosy สำหรับช่วยสังเกตในช่องรายการสินค้า (SKU):
${skuHintList}

กฎเหล็กในการอ่านใบปะหน้าพัสดุ:
1. เลขพัสดุ / หมายเลขติดตามพัสดุ (trackingId):
   - อ่านตัวอักษรและตัวเลขใต้บาร์โค้ดหลักของขนส่งอย่างแม่นยำ ห้ามเว้นวรรค เช่น:
     * Shopee Xpress (SPX): มักขึ้นต้นด้วย "SPXTH..." (เช่น SPXTH06812345678A)
     * Flash Express: มักขึ้นต้นด้วย "TH..." (เช่น TH010158A9123B หรือ THT...)
     * J&T Express: มักเป็นตัวเลข 12 หลัก (เช่น 821234567890 หรือ 61...)
     * BEST Express: มักเป็นตัวเลข 14 หลักขึ้นต้นด้วย 66 (เช่น 66850123456789)
     * KEX / Kerry Express: มักขึ้นต้นด้วย KEX..., KER..., SHP..., SDOF...
     * LEX (Lazada Express): มักขึ้นต้นด้วย LEX... หรือ LXAD...
     * ไปรษณีย์ไทย (EMS): เช่น ED123456789TH, JA...TH
2. ชื่อขนส่ง (carrier):
   - ระบุชื่อขนส่งจากโลโก้หรือหัวใบปะหน้า เช่น "Shopee Xpress (SPX)", "Flash Express", "J&T Express", "KEX Express", "LEX (Lazada Express)", "BEST Express", "ไปรษณีย์ไทย"
3. เลขคำสั่งซื้อ (orderId) และช่องทางขาย (platform):
   - อ่าน Order ID / Order SN บนใบปะหน้า เช่น:
     * Shopee: รหัส 14 หลัก เช่น "261027ABC12345" (platform: "Shopee")
     * TikTok Shop: ตัวเลขล้วน 18-20 หลัก ขึ้นต้นด้วย 57/58 (เช่น "579123456789012345", platform: "TikTok Shop")
     * Lazada: ตัวเลข 15-16 หลัก (platform: "Lazada")
4. ชื่อลูกค้า (customerName) และ จังหวัดปลายทาง (province):
   - อ่านชื่อผู้รับ (ถึง / To / ผู้รับ) และจังหวัดปลายทาง (เช่น "กรุงเทพมหานคร", "ชลบุรี", "เชียงใหม่", "สมุทรปราการ")
5. รายละเอียดสินค้า / รหัส SKU / สี / จำนวน (sku, productName, qty):
   - อ่านรายการสินค้าที่พิมพ์อยู่ด้านล่างของใบปะหน้า (ถ้าไม่ถูกตัดออก) เช่น รุ่นโซฟา รหัส SKU สี และจำนวนชิ้น (qty)

ตอบกลับมาเป็น JSON Object เท่านั้น ตามโครงสร้างนี้:
{
  "trackingId": "เลขพัสดุตัวพิมพ์ใหญ่ติดกันไม่มีเว้นวรรค",
  "orderId": "หมายเลขคำสั่งซื้อ (ถ้ามีบนใบปะหน้า)",
  "carrier": "ชื่อขนส่ง",
  "platform": "Shopee | TikTok Shop | Lazada | เพจร้าน",
  "customerName": "ชื่อผู้รับสินค้า",
  "province": "จังหวัดปลายทาง",
  "sku": "รหัส SKU และสี หรือชื่อสินค้าที่ปรากฏบนใบลาเบล",
  "productName": "ชื่อรุ่นสินค้าเต็ม",
  "qty": 1,
  "confidence": "HIGH | MEDIUM | LOW",
  "notes": "ข้อสังเกตเพิ่มเติม เช่น บาร์โค้ดชัดเจน หรือใบปะหน้ายับบางส่วน"
}`;
  }

  function extractJsonFromText(rawText) {
    if (!rawText) throw new Error('Empty response from Gemini AI');
    let text = String(rawText).trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      text = fenceMatch[1].trim();
    }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      text = text.slice(firstBrace, lastBrace + 1);
    }
    return JSON.parse(text);
  }

  function normalizeExtractedLabelData(rawParsed) {
    const p = rawParsed || {};
    const cleanTrk = normalizeTracking(p.trackingId || p.tracking_id || p.trackingNumber || '');
    const cleanOrd = normalizeOrderId(p.orderId || p.order_id || p.orderSn || '');
    const carrier = detectCarrier(cleanTrk, p.carrier || '');
    const platform = detectPlatform(cleanOrd, p.platform || '', carrier);
    const skuText = String(p.sku || p.productName || p.product_name || '').trim();
    const productName = String(p.productName || p.sku || '').trim();
    const qty = Math.max(1, parseInt(p.qty || p.quantity || 1, 10) || 1);

    return {
      trackingId: cleanTrk,
      cleanTracking: cleanTrk,
      orderId: cleanOrd,
      cleanOrderId: cleanOrd,
      carrier: carrier,
      platform: platform,
      customerName: String(p.customerName || p.customer_name || '').trim(),
      province: String(p.province || '').trim(),
      sku: skuText,
      productName: productName,
      qty: qty,
      confidence: p.confidence || (cleanTrk ? 'HIGH' : 'LOW'),
      notes: String(p.notes || '').trim()
    };
  }

  async function scanLabelImageWithGemini(base64Data, mimeType, apiKey, preferredModel) {
    if (!apiKey) {
      throw new Error('ยังไม่ได้ตั้งค่า Gemini API Key กรุณาไปที่แท็บ "ตั้งค่า LINE Bot & Gemini API" เพื่อใส่คีย์');
    }

    const cleanBase64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
    const cleanMime = mimeType || 'image/jpeg';
    const modelsToTry = [
      preferredModel || DEFAULT_GEMINI_MODEL,
      'gemini-flash-latest',
      'gemini-2.0-flash',
      'gemini-1.5-flash'
    ].filter((v, idx, arr) => v && arr.indexOf(v) === idx);

    const promptText = buildParcelLabelPrompt();
    let lastError = null;

    for (const model of modelsToTry) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: promptText },
                  {
                    inline_data: {
                      mime_type: cleanMime,
                      data: cleanBase64
                    }
                  }
                ]
              }
            ],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: 'application/json'
            }
          })
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Gemini HTTP ${response.status}: ${errText.slice(0, 200)}`);
        }

        const json = await response.json();
        const candidateText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const parsed = extractJsonFromText(candidateText);
        return normalizeExtractedLabelData(parsed);
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('ไม่สามารถเชื่อมต่อ Gemini Vision API ได้');
  }

  // ===========================================================================
  // 4. INDEXEDDB LOCAL IMAGE & DATA CACHE (BROWSER ONLY)
  // ===========================================================================

  const IDB_NAME = 'qc_parcel_label_tracker_idb_v1';
  const IDB_VERSION = 1;
  let idbInstance = null;

  function getIDB() {
    if (typeof window === 'undefined' || !window.indexedDB) return Promise.resolve(null);
    if (idbInstance) return Promise.resolve(idbInstance);
    return new Promise((resolve) => {
      try {
        const req = window.indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('images')) {
            db.createObjectStore('images');
          }
          if (!db.objectStoreNames.contains('daily_state')) {
            db.createObjectStore('daily_state');
          }
        };
        req.onsuccess = (e) => {
          idbInstance = e.target.result;
          resolve(idbInstance);
        };
        req.onerror = () => resolve(null);
      } catch (err) {
        resolve(null);
      }
    });
  }

  async function idbGet(storeName, key) {
    const db = await getIDB();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function idbSet(storeName, key, val) {
    const db = await getIDB();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(val, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  // ===========================================================================
  // 5. SUPABASE CLOUD REST API & REAL-TIME MULTI-NAMESPACE PERSISTENCE
  // ===========================================================================

  function getLocalConfig() {
    if (typeof localStorage === 'undefined') {
      return {
        supabaseUrl: DEFAULT_SUPABASE_URL,
        supabaseKey: DEFAULT_SUPABASE_KEY,
        geminiApiKey: '',
        geminiModel: DEFAULT_GEMINI_MODEL,
        lineChannelId: '',
        lineChannelSecret: '',
        lineChannelAccessToken: '',
        staffName: 'ฝ่ายติดตามพัสดุ'
      };
    }
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.CONFIG) || '{}');
      return {
        supabaseUrl: raw.supabaseUrl || DEFAULT_SUPABASE_URL,
        supabaseKey: raw.supabaseKey || DEFAULT_SUPABASE_KEY,
        geminiApiKey: raw.geminiApiKey || '',
        geminiModel: raw.geminiModel || DEFAULT_GEMINI_MODEL,
        lineChannelId: raw.lineChannelId || '',
        lineChannelSecret: raw.lineChannelSecret || '',
        lineChannelAccessToken: raw.lineChannelAccessToken || '',
        staffName: raw.staffName || 'ฝ่ายติดตามพัสดุ'
      };
    } catch (e) {
      return {
        supabaseUrl: DEFAULT_SUPABASE_URL,
        supabaseKey: DEFAULT_SUPABASE_KEY,
        geminiApiKey: '',
        geminiModel: DEFAULT_GEMINI_MODEL,
        lineChannelId: '',
        lineChannelSecret: '',
        lineChannelAccessToken: '',
        staffName: 'ฝ่ายติดตามพัสดุ'
      };
    }
  }

  function saveLocalConfig(newCfg) {
    const merged = Object.assign({}, getLocalConfig(), newCfg);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(merged));
      } catch (e) {}
    }
    return merged;
  }

  async function supabaseRequest(path, options = {}, customUrl, customKey) {
    const localCfg = getLocalConfig();
    const sUrl = customUrl || localCfg.supabaseUrl || DEFAULT_SUPABASE_URL;
    const sKey = customKey || localCfg.supabaseKey || DEFAULT_SUPABASE_KEY;
    const headers = Object.assign(
      {
        'apikey': sKey,
        'Authorization': `Bearer ${sKey}`,
        'Content-Type': 'application/json'
      },
      options.headers || {}
    );

    const res = await fetch(`${sUrl}/rest/v1/${path}`, Object.assign({}, options, { headers }));
    return res;
  }

  /**
   * Fetches config from QC_LABEL_CONFIG_V1, and seamlessly inherits Gemini API Key
   * from QC_BUDGET_CONFIG_V1 / QC_PAYROLL_CONFIG_V1 if not overridden yet.
   */
  async function fetchCloudConfig(customUrl, customKey) {
    try {
      const res = await supabaseRequest(
        'production_batches?batch_id=in.(QC_LABEL_CONFIG_V1,QC_BUDGET_CONFIG_V1,QC_PAYROLL_CONFIG_V1)&select=batch_id,items_json',
        { method: 'GET' },
        customUrl,
        customKey
      );
      if (!res.ok) return getLocalConfig();
      const rows = await res.json();
      if (!Array.isArray(rows)) return getLocalConfig();

      let labelCfg = {};
      let budgetCfg = {};
      let payrollCfg = {};

      for (const r of rows) {
        const data = typeof r.items_json === 'string' ? JSON.parse(r.items_json || '{}') : (r.items_json || {});
        if (r.batch_id === 'QC_LABEL_CONFIG_V1') labelCfg = data;
        if (r.batch_id === 'QC_BUDGET_CONFIG_V1') budgetCfg = data;
        if (r.batch_id === 'QC_PAYROLL_CONFIG_V1') payrollCfg = data;
      }

      const localCfg = getLocalConfig();
      const resolved = {
        supabaseUrl: localCfg.supabaseUrl || DEFAULT_SUPABASE_URL,
        supabaseKey: localCfg.supabaseKey || DEFAULT_SUPABASE_KEY,
        geminiApiKey:
          labelCfg.geminiApiKey ||
          localCfg.geminiApiKey ||
          budgetCfg.geminiApiKey ||
          payrollCfg.geminiApiKey ||
          '',
        geminiModel:
          labelCfg.geminiModel ||
          localCfg.geminiModel ||
          budgetCfg.geminiModel ||
          payrollCfg.geminiModel ||
          DEFAULT_GEMINI_MODEL,
        lineChannelId: labelCfg.lineChannelId || localCfg.lineChannelId || '',
        lineChannelSecret: labelCfg.lineChannelSecret || localCfg.lineChannelSecret || '',
        lineChannelAccessToken: labelCfg.lineChannelAccessToken || localCfg.lineChannelAccessToken || '',
        staffName: labelCfg.staffName || localCfg.staffName || 'ฝ่ายติดตามพัสดุ'
      };

      saveLocalConfig(resolved);
      return resolved;
    } catch (e) {
      console.warn('fetchCloudConfig warning:', e);
      return getLocalConfig();
    }
  }

  async function saveCloudConfig(configObj, customUrl, customKey) {
    try {
      const existing = await fetchCloudConfig(customUrl, customKey);
      const merged = Object.assign({}, existing, configObj, { updatedAt: new Date().toISOString() });
      saveLocalConfig(merged);

      const payload = {
        batch_id: 'QC_LABEL_CONFIG_V1',
        batch_name: 'Parcel Label Tracker LINE Bot & Gemini AI Config',
        source: 'QC_LABEL_CONFIG',
        status: 'COMPLETED',
        total_skus: 1,
        total_units: 1,
        total_material_cost: 0,
        items_json: merged,
        updated_at: new Date().toISOString()
      };

      const res = await supabaseRequest(
        'production_batches?on_conflict=batch_id',
        {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(payload)
        },
        customUrl,
        customKey
      );
      return res.ok;
    } catch (e) {
      console.warn('saveCloudConfig error:', e);
      return false;
    }
  }

  /**
   * Saves separate image row in QC_LABEL_IMG_<scanId> so main table sync stays < 0.5s
   */
  async function saveLabelImageToCloud(scanId, imageDataUrl, meta = {}, customUrl, customKey) {
    if (!scanId || !imageDataUrl) return false;
    memoryImageCache.set(scanId, imageDataUrl);
    await idbSet('images', scanId, imageDataUrl);

    try {
      const payload = {
        batch_id: `QC_LABEL_IMG_${scanId}`,
        batch_name: `Label Image ${meta.trackingId || scanId} (${meta.scanDate || ''})`,
        source: 'QC_LABEL_IMAGE',
        status: 'COMPLETED',
        total_skus: 1,
        total_units: 1,
        total_material_cost: 0,
        items_json: {
          scanId: scanId,
          trackingId: meta.trackingId || '',
          orderId: meta.orderId || '',
          scanDate: meta.scanDate || '',
          imageDataUrl: imageDataUrl
        },
        updated_at: new Date().toISOString()
      };

      const res = await supabaseRequest(
        'production_batches?on_conflict=batch_id',
        {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(payload)
        },
        customUrl,
        customKey
      );
      return res.ok;
    } catch (e) {
      console.warn('saveLabelImageToCloud error:', e);
      return false;
    }
  }

  async function fetchLabelImage(scanId, customUrl, customKey) {
    if (!scanId) return '';
    if (memoryImageCache.has(scanId)) {
      return memoryImageCache.get(scanId);
    }
    const idbImg = await idbGet('images', scanId);
    if (idbImg) {
      memoryImageCache.set(scanId, idbImg);
      return idbImg;
    }

    try {
      const res = await supabaseRequest(
        `production_batches?batch_id=eq.${encodeURIComponent('QC_LABEL_IMG_' + scanId)}&select=items_json`,
        { method: 'GET' },
        customUrl,
        customKey
      );
      if (!res.ok) return '';
      const rows = await res.json();
      const row = rows && rows[0];
      if (!row || !row.items_json) return '';
      const parsed = typeof row.items_json === 'string' ? JSON.parse(row.items_json) : row.items_json;
      const imgUrl = parsed?.imageDataUrl || '';
      if (imgUrl) {
        memoryImageCache.set(scanId, imgUrl);
        await idbSet('images', scanId, imgUrl);
      }
      return imgUrl;
    } catch (e) {
      console.warn('fetchLabelImage error:', e);
      return '';
    }
  }

  /**
   * Saves daily label scan list (slim metadata without base64 images) to QC_LABEL_SCAN_<date>
   */
  async function saveLabelScansToCloud(date, labelScans, updatedBy = 'ระบบ AI', customUrl, customKey) {
    const targetDate = date || getTodayString();
    const deduplicated = deduplicateLabelScans(labelScans);

    // Strip heavy base64 strings from metadata row (keep SVG sample URLs only if tiny, or store in image table)
    const slimScans = deduplicated.map((s) => {
      const hasImg = Boolean(s.hasCloudImage || s.imageDataUrl);
      if (s.imageDataUrl && s.id) {
        memoryImageCache.set(s.id, s.imageDataUrl);
        idbSet('images', s.id, s.imageDataUrl);
      }
      return Object.assign({}, s, {
        scanDate: s.scanDate || targetDate,
        imageDataUrl: '',
        hasCloudImage: hasImg
      });
    });

    try {
      const payload = {
        batch_id: `QC_LABEL_SCAN_${targetDate}`,
        batch_name: `Parcel Label Scans ${targetDate}`,
        source: 'QC_LABEL_SCAN',
        status: 'COMPLETED',
        total_skus: slimScans.length,
        total_units: slimScans.reduce((sum, x) => sum + (parseInt(x.qty, 10) || 1), 0),
        total_material_cost: 0,
        imported_by: updatedBy,
        items_json: {
          date: targetDate,
          scans: slimScans,
          updatedAt: new Date().toISOString(),
          updatedBy: updatedBy
        },
        updated_at: new Date().toISOString()
      };

      const res = await supabaseRequest(
        'production_batches?on_conflict=batch_id',
        {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(payload)
        },
        customUrl,
        customKey
      );
      return res.ok;
    } catch (e) {
      console.warn('saveLabelScansToCloud error:', e);
      return false;
    }
  }

  /**
   * Saves extra orders imported directly in parcel-label-tracker to QC_LABEL_ORDERS_<date>
   * (100% isolated from QC_PARCEL_DATA_<date> so daily-parcel-checker is never overwritten)
   */
  async function saveExtraOrdersToCloud(date, extraOrders, updatedBy = 'ฝ่ายจัดส่ง', customUrl, customKey) {
    const targetDate = date || getTodayString();
    const cleanOrders = deduplicateOrderArray(extraOrders);
    try {
      const payload = {
        batch_id: `QC_LABEL_ORDERS_${targetDate}`,
        batch_name: `Parcel Label Extra Orders ${targetDate}`,
        source: 'QC_LABEL_ORDERS',
        status: 'COMPLETED',
        total_skus: cleanOrders.length,
        total_units: cleanOrders.reduce((sum, o) => sum + (parseInt(o.qty, 10) || 1), 0),
        total_material_cost: 0,
        imported_by: updatedBy,
        items_json: {
          date: targetDate,
          orders: cleanOrders,
          updatedAt: new Date().toISOString(),
          updatedBy: updatedBy
        },
        updated_at: new Date().toISOString()
      };

      const res = await supabaseRequest(
        'production_batches?on_conflict=batch_id',
        {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(payload)
        },
        customUrl,
        customKey
      );
      return res.ok;
    } catch (e) {
      console.warn('saveExtraOrdersToCloud error:', e);
      return false;
    }
  }

  /**
   * Fetches all 3 cloud rows for a given date in a single fast PostgREST query:
   * - QC_PARCEL_DATA_<date>   (Read-Only from daily-parcel-checker: orders + QR scans)
   * - QC_LABEL_ORDERS_<date>  (Orders imported directly into parcel-label-tracker)
   * - QC_LABEL_SCAN_<date>    (Label photo scans + follow-up tracking statuses)
   */
  async function syncDailyDataFromCloud(date, customUrl, customKey) {
    const targetDate = date || getTodayString();
    const bParcel = `QC_PARCEL_DATA_${targetDate}`;
    const bLabelOrders = `QC_LABEL_ORDERS_${targetDate}`;
    const bLabelScan = `QC_LABEL_SCAN_${targetDate}`;

    let qrSystemOrders = [];
    let qrScans = [];
    let extraOrders = [];
    let labelScans = [];

    try {
      const query = `production_batches?batch_id=in.(${encodeURIComponent(bParcel)},${encodeURIComponent(bLabelOrders)},${encodeURIComponent(bLabelScan)})&select=batch_id,items_json,updated_at,imported_by`;
      const res = await supabaseRequest(query, { method: 'GET' }, customUrl, customKey);

      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows)) {
          for (const row of rows) {
            const parsed = typeof row.items_json === 'string'
              ? JSON.parse(row.items_json || '{}')
              : (row.items_json || {});

            if (row.batch_id === bParcel) {
              qrSystemOrders = Array.isArray(parsed.orders) ? parsed.orders : [];
              qrScans = Array.isArray(parsed.scans) ? parsed.scans : [];
            } else if (row.batch_id === bLabelOrders) {
              extraOrders = Array.isArray(parsed.orders) ? parsed.orders : [];
            } else if (row.batch_id === bLabelScan) {
              labelScans = Array.isArray(parsed.scans) ? parsed.scans : [];
            }
          }
        }
      }
    } catch (e) {
      console.warn('syncDailyDataFromCloud warning:', e);
    }

    const mergedOrders = deduplicateOrderArray([...qrSystemOrders, ...extraOrders]);
    const cleanLabelScans = deduplicateLabelScans(labelScans);
    const reconciled = reconcileThreeWayStatus(mergedOrders, qrScans, cleanLabelScans, targetDate);

    const result = {
      date: targetDate,
      qrSystemOrders,
      extraOrders,
      orders: mergedOrders,
      qrScans,
      labelScans: cleanLabelScans,
      reconciled
    };

    await idbSet('daily_state', targetDate, result);
    return result;
  }

  /**
   * Used by LINE Webhook & Web Upload to record a single scanned label photo,
   * automatically matching against today's (or recent days') orders & QR scans,
   * enforcing 1 tracking = 1 record per day, and saving both image & metadata.
   */
  async function recordIncomingLabelScan(extractedData, imageDataUrl, options = {}, customUrl, customKey) {
    const today = options.date || getTodayString();
    const sourceChannel = options.sourceChannel || 'LINE_GROUP';
    const senderName = options.senderName || 'ทีมแพ็ค/ส่งของ';

    // 1. Check today's data first; if not matched, also check yesterday's orders in case of cross-day packing
    const todayData = await syncDailyDataFromCloud(today, customUrl, customKey);
    let targetDate = today;
    let targetData = todayData;

    const cleanTrk = normalizeTracking(extractedData.trackingId || '');
    const cleanOrd = normalizeOrderId(extractedData.orderId || '');

    const matchInData = (dataObj) => {
      if (!dataObj) return { order: null, qrScan: null };
      const ord = dataObj.orders.find((o) =>
        (cleanTrk && normalizeTracking(o.cleanTracking || o.trackingId) === cleanTrk) ||
        (cleanOrd && normalizeOrderId(o.orderId) === cleanOrd)
      ) || null;
      const qr = dataObj.qrScans.find((s) =>
        (cleanTrk && normalizeTracking(s.cleanTracking || s.trackingId) === cleanTrk) ||
        (cleanOrd && normalizeOrderId(s.matchedOrderId) === cleanOrd)
      ) || null;
      return { order: ord, qrScan: qr };
    };

    let matched = matchInData(todayData);

    // If not found in today's orders/QR scans and user didn't force a specific date, check yesterday
    if (!matched.order && !matched.qrScan && !options.strictDate && (cleanTrk || cleanOrd)) {
      const yesterday = adjustDateString(today, -1);
      const yestData = await syncDailyDataFromCloud(yesterday, customUrl, customKey);
      const yestMatch = matchInData(yestData);
      if (yestMatch.order || yestMatch.qrScan) {
        targetDate = yesterday;
        targetData = yestData;
        matched = yestMatch;
      }
    }

    // Check if this tracking/order was already photographed on targetDate (Deduplication!)
    const existingScan = targetData.labelScans.find((ls) =>
      (cleanTrk && ls.cleanTracking === cleanTrk) ||
      (cleanOrd && ls.cleanOrderId === cleanOrd)
    );

    const scanId = existingScan
      ? existingScan.id
      : `LBL-${Date.now()}-${Math.floor(Math.random() * 900 + 100)}`;

    const nowTime = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(11, 19);

    const newScanObj = {
      id: scanId,
      scanDate: targetDate,
      scanTime: nowTime,
      trackingId: cleanTrk || (matched.order ? matched.order.trackingId : '') || '',
      cleanTracking: cleanTrk || (matched.order ? normalizeTracking(matched.order.trackingId) : '') || '',
      orderId: extractedData.orderId || (matched.order ? matched.order.orderId : '') || (matched.qrScan ? matched.qrScan.matchedOrderId : '') || '',
      cleanOrderId: cleanOrd || (matched.order ? normalizeOrderId(matched.order.orderId) : '') || '',
      carrier: detectCarrier(cleanTrk, extractedData.carrier || (matched.order ? matched.order.carrier : '')),
      platform: detectPlatform(extractedData.orderId || (matched.order ? matched.order.orderId : ''), extractedData.platform, extractedData.carrier),
      sku: (matched.order && matched.order.sku) ? matched.order.sku : (extractedData.sku || extractedData.productName || ''),
      productName: extractedData.productName || (matched.order ? matched.order.sku : '') || '',
      qty: (matched.order && matched.order.qty) ? (parseInt(matched.order.qty, 10) || 1) : (extractedData.qty || 1),
      customerName: extractedData.customerName || (matched.order ? matched.order.customerName : '') || '',
      province: extractedData.province || (matched.order ? matched.order.province : '') || '',
      confidence: extractedData.confidence || 'HIGH',
      notes: extractedData.notes || '',
      sourceChannel: sourceChannel,
      senderName: senderName,
      hasCloudImage: Boolean(imageDataUrl || (existingScan && existingScan.hasCloudImage)),
      followUpStatus: existingScan ? existingScan.followUpStatus : 'PENDING_PICKUP',
      currentHub: existingScan ? existingScan.currentHub : '',
      followUpNote: existingScan ? existingScan.followUpNote : '',
      checkedBy: existingScan ? existingScan.checkedBy : '',
      checkedAt: existingScan ? existingScan.checkedAt : '',
      updatedAt: new Date().toISOString()
    };

    // 2. Save Image in isolated row QC_LABEL_IMG_<scanId>
    if (imageDataUrl) {
      await saveLabelImageToCloud(scanId, imageDataUrl, newScanObj, customUrl, customKey);
    }

    // 3. Deduplicate & Save Label Scans list for targetDate
    const updatedList = deduplicateLabelScans([...targetData.labelScans, newScanObj]);
    await saveLabelScansToCloud(targetDate, updatedList, senderName, customUrl, customKey);

    // 4. Determine 3-Way Verification Result for instant LINE Bot reply / UI feedback
    const hasOrder = Boolean(matched.order);
    const hasQr = Boolean(matched.qrScan);
    let threeWayStatus = 'UNMATCHED_PHOTO';
    if (hasOrder && hasQr) threeWayStatus = 'VERIFIED_ALL';
    else if (hasOrder && !hasQr) threeWayStatus = 'PHOTO_ONLY';
    else if (!hasOrder && hasQr) threeWayStatus = 'VERIFIED_ALL'; // QR was scanned and photo taken

    return {
      scan: newScanObj,
      targetDate,
      isUpdatedExisting: Boolean(existingScan),
      hasOrder,
      hasQr,
      threeWayStatus,
      matchedOrder: matched.order,
      matchedQrScan: matched.qrScan
    };
  }

  /**
   * Fetches multiple days of data for Tab 3 Follow-Up Monitor
   */
  async function fetchMultiDayDataFromCloud(dates = [], customUrl, customKey) {
    if (!Array.isArray(dates) || dates.length === 0) return [];
    const results = await Promise.all(dates.map((d) => syncDailyDataFromCloud(d, customUrl, customKey)));
    return results;
  }

  // ===========================================================================
  // 6. EXCEL / CSV PARSERS (ORDERS & CARRIER FOLLOW-UP STATUS BULK UPDATE)
  // ===========================================================================

  function parseOrderRows(rows, targetDate) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const shipDate = targetDate || getTodayString();

    // Find header row within first 10 rows
    let headerIdx = 0;
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const rowStr = (rows[i] || []).join(' ').toLowerCase();
      if (
        rowStr.includes('tracking') ||
        rowStr.includes('พัสดุ') ||
        rowStr.includes('order') ||
        rowStr.includes('คำสั่งซื้อ') ||
        rowStr.includes('sku')
      ) {
        headerIdx = i;
        break;
      }
    }

    const headers = (rows[headerIdx] || []).map((h) =>
      String(h !== null && h !== undefined ? h : '').trim().toLowerCase()
    );

    const findCol = (keywords, excludes = []) => {
      for (const kw of keywords) {
        const idx = headers.findIndex((h) => {
          if (!h) return false;
          if (excludes.some((ex) => h.includes(ex))) return false;
          return h === kw || h.includes(kw);
        });
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const idxTrack = findCol(['หมายเลขติดตามพัสดุ', 'tracking', 'เลขพัสดุ', 'เลขติดตาม', 'waybill'], ['วัน', 'date', 'เวลา']);
    const idxOrder = findCol(['หมายเลขคำสั่งซื้อ', 'order id', 'รหัสคำสั่งซื้อ', 'order sn', 'order no', 'คำสั่งซื้อ', 'เลขออเดอร์'], ['วัน', 'date', 'status', 'สถานะ', 'tracking']);
    const idxSku = findCol(['seller sku', 'เลขอ้างอิง sku', 'รหัสสินค้า', 'sku', 'ชื่อสินค้า', 'product name'], ['quantity', 'จำนวน']);
    const idxVar = findCol(['ชื่อตัวเลือก', 'variation', 'ตัวเลือก', 'สี', 'ขนาด']);
    const idxQty = findCol(['จำนวน', 'quantity', 'qty'], ['คืน', 'ยกเลิก', 'return', 'cancel']);
    const idxCarrier = findCol(['ผู้ให้บริการจัดส่ง', 'shipping provider', 'ขนส่ง', 'carrier', 'delivery']);
    const idxCustomer = findCol(['ชื่อผู้รับ', 'recipient', 'buyer', 'ชื่อลูกค้า', 'ลูกค้า', 'receiver']);
    const idxProvince = findCol(['จังหวัด', 'province', 'state']);
    const idxPlatform = findCol(['ช่องทาง', 'platform', 'channel', 'ร้านค้า']);
    const idxStatus = findCol(['สถานะคำสั่งซื้อ', 'order status', 'สถานะ']);

    const parsedOrders = [];

    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row) || row.every((c) => !String(c || '').trim())) continue;

      let rawTrack = idxTrack !== -1 ? String(row[idxTrack] || '').trim() : '';
      let rawOrder = idxOrder !== -1 ? String(row[idxOrder] || '').trim() : '';
      let rawSku = idxSku !== -1 ? String(row[idxSku] || '').trim() : '';
      const rawVar = idxVar !== -1 ? String(row[idxVar] || '').trim() : '';
      const rawQty = idxQty !== -1 ? parseInt(row[idxQty], 10) || 1 : 1;
      const rawCarrier = idxCarrier !== -1 ? String(row[idxCarrier] || '').trim() : '';
      const rawCustomer = idxCustomer !== -1 ? String(row[idxCustomer] || '').trim() : '';
      const rawProvince = idxProvince !== -1 ? String(row[idxProvince] || '').trim() : '';
      const rawPlatform = idxPlatform !== -1 ? String(row[idxPlatform] || '').trim() : '';
      const rawStatus = idxStatus !== -1 ? String(row[idxStatus] || '').trim() : '';

      // Heuristic fallback if header wasn't standard
      if (idxTrack === -1 && idxOrder === -1) {
        row.forEach((cell) => {
          const val = String(cell || '').trim();
          if (!rawTrack && /^(SPXTH|TH\d{8,}|THT|66\d{12}|82\d{10}|KEX|KER|LEX)/i.test(val)) {
            rawTrack = val;
          } else if (!rawOrder && /^(\d{14,20}|\d{6}[A-Z0-9]{8})$/i.test(val)) {
            rawOrder = val;
          }
        });
      }

      if (!rawTrack && !rawOrder) continue;

      if (rawVar && rawSku && !rawSku.includes(rawVar)) {
        rawSku = `${rawSku} (${rawVar})`;
      } else if (rawVar && !rawSku) {
        rawSku = rawVar;
      }

      const cleanTrk = normalizeTracking(rawTrack);
      const isCancelled = rawStatus.includes('ยกเลิก') || rawStatus.toLowerCase().includes('cancel');

      parsedOrders.push({
        id: `ORD-${Date.now()}-${r}`,
        shipDate: shipDate,
        orderId: rawOrder,
        trackingId: rawTrack || cleanTrk,
        cleanTracking: cleanTrk,
        sku: rawSku || 'ไม่ระบุ SKU',
        qty: rawQty,
        carrier: detectCarrier(cleanTrk, rawCarrier),
        platform: detectPlatform(rawOrder, rawPlatform, rawCarrier),
        customerName: rawCustomer,
        province: rawProvince,
        orderStatus: rawStatus,
        isCancelled: isCancelled
      });
    }

    return deduplicateOrderArray(parsedOrders);
  }

  /**
   * Parses carrier tracking export Excel/CSV to bulk-update followUpStatus & currentHub
   */
  function parseCarrierStatusRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    let headerIdx = 0;
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const s = (rows[i] || []).join(' ').toLowerCase();
      if (s.includes('tracking') || s.includes('พัสดุ') || s.includes('สถานะ') || s.includes('status')) {
        headerIdx = i;
        break;
      }
    }

    const headers = (rows[headerIdx] || []).map((h) => String(h || '').trim().toLowerCase());
    const findCol = (kws) => headers.findIndex((h) => kws.some((k) => h.includes(k)));

    const idxTrack = findCol(['tracking', 'พัสดุ', 'waybill', 'เลขติดตาม']);
    const idxStatus = findCol(['สถานะขนส่ง', 'สถานะการติดตาม', 'สถานะ', 'status', 'delivery']);
    const idxHub = findCol(['ศูนย์คัดแยก', 'จังหวัดปัจจุบัน', 'ตำแหน่ง', 'hub', 'location']);
    const idxNote = findCol(['หมายเหตุ', 'note', 'remark']);

    const updates = [];
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;
      const rawTrk = idxTrack !== -1 ? String(row[idxTrack] || '').trim() : String(row[0] || '').trim();
      const cleanTrk = normalizeTracking(rawTrk);
      if (!cleanTrk) continue;

      const rawSt = idxStatus !== -1 ? String(row[idxStatus] || '').trim() : String(row[1] || '').trim();
      const rawHub = idxHub !== -1 ? String(row[idxHub] || '').trim() : '';
      const rawNote = idxNote !== -1 ? String(row[idxNote] || '').trim() : '';

      let mappedStatus = 'IN_TRANSIT';
      const stLower = rawSt.toLowerCase();
      if (stLower.includes('สำเร็จ') || stLower.includes('delivered') || stLower.includes('เซ็นรับ')) {
        mappedStatus = 'DELIVERED';
      } else if (stLower.includes('นำจ่าย') || stLower.includes('out for delivery')) {
        mappedStatus = 'OUT_FOR_DELIVERY';
      } else if (stLower.includes('ตีกลับ') || stLower.includes('return')) {
        mappedStatus = 'RETURNED';
      } else if (stLower.includes('ปัญหา') || stLower.includes('ตกค้าง') || stLower.includes('ไม่สำเร็จ') || stLower.includes('issue')) {
        mappedStatus = 'ISSUE';
      } else if (stLower.includes('รอรับ') || stLower.includes('pending')) {
        mappedStatus = 'PENDING_PICKUP';
      }

      updates.push({
        cleanTracking: cleanTrk,
        followUpStatus: mappedStatus,
        currentHub: rawHub,
        followUpNote: rawNote || rawSt
      });
    }
    return updates;
  }

  // ===========================================================================
  // 7. REALISTIC SAMPLE PARCEL LABEL SVG GENERATOR (FOR INSTANT TESTING)
  // ===========================================================================

  function svgToDataUrl(svgString) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString.trim());
  }

  function createSampleLabelSvg({ carrier, trackingId, orderId, platform, customerName, province, sku, qty, sortCode }) {
    const isSpx = carrier.includes('SPX') || carrier.includes('Shopee');
    const isFlash = carrier.includes('Flash');
    const headerBg = isSpx ? '#ee4d2d' : (isFlash ? '#eab308' : '#0284c7');
    const headerText = isFlash ? '#0f172a' : '#ffffff';

    return svgToDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="560" height="720" viewBox="0 0 560 720">
      <!-- Sofa bubble-wrap parcel background -->
      <rect width="560" height="720" fill="#cbd5e1"/>
      <rect x="14" y="14" width="532" height="692" rx="16" fill="#94a3b8" stroke="#64748b" stroke-width="2" stroke-dasharray="8,6"/>
      <!-- Thermal Label Sticker -->
      <rect x="38" y="34" width="484" height="652" rx="8" fill="#ffffff" stroke="#1e293b" stroke-width="2.5"/>
      <!-- Header Banner -->
      <rect x="38" y="34" width="484" height="68" rx="6" fill="${headerBg}"/>
      <text x="60" y="76" font-family="Inter, Sarabun, sans-serif" font-size="24" font-weight="bold" fill="${headerText}">${carrier}</text>
      <rect x="370" y="48" width="132" height="40" rx="6" fill="#0f172a"/>
      <text x="436" y="75" font-family="Inter, sans-serif" font-size="18" font-weight="bold" fill="#ffffff" text-anchor="middle">${platform}</text>

      <!-- Sort Code & Barcode Area -->
      <rect x="56" y="118" width="448" height="145" fill="#f8fafc" stroke="#334155" stroke-width="1.5"/>
      <text x="280" y="146" font-family="Inter, monospace" font-size="15" font-weight="bold" fill="#475569" text-anchor="middle">SORT CODE: ${sortCode || 'BKK-04-A2'}</text>
      <!-- Simulated Barcode Bars -->
      <g fill="#0f172a">
        <rect x="88" y="158" width="6" height="58"/><rect x="100" y="158" width="3" height="58"/><rect x="108" y="158" width="9" height="58"/>
        <rect x="122" y="158" width="4" height="58"/><rect x="132" y="158" width="8" height="58"/><rect x="146" y="158" width="3" height="58"/>
        <rect x="155" y="158" width="10" height="58"/><rect x="170" y="158" width="4" height="58"/><rect x="180" y="158" width="6" height="58"/>
        <rect x="192" y="158" width="11" height="58"/><rect x="208" y="158" width="3" height="58"/><rect x="216" y="158" width="7" height="58"/>
        <rect x="228" y="158" width="5" height="58"/><rect x="238" y="158" width="9" height="58"/><rect x="252" y="158" width="4" height="58"/>
        <rect x="262" y="158" width="8" height="58"/><rect x="275" y="158" width="3" height="58"/><rect x="284" y="158" width="10" height="58"/>
        <rect x="300" y="158" width="5" height="58"/><rect x="310" y="158" width="7" height="58"/><rect x="322" y="158" width="4" height="58"/>
        <rect x="332" y="158" width="9" height="58"/><rect x="346" y="158" width="3" height="58"/><rect x="355" y="158" width="8" height="58"/>
        <rect x="368" y="158" width="6" height="58"/><rect x="380" y="158" width="10" height="58"/><rect x="396" y="158" width="4" height="58"/>
        <rect x="406" y="158" width="7" height="58"/><rect x="418" y="158" width="5" height="58"/><rect x="428" y="158" width="9" height="58"/>
        <rect x="442" y="158" width="4" height="58"/><rect x="452" y="158" width="8" height="58"/><rect x="465" y="158" width="5" height="58"/>
      </g>
      <text x="280" y="245" font-family="Inter, monospace" font-size="22" font-weight="bold" fill="#0f172a" text-anchor="middle" letter-spacing="2">${trackingId}</text>

      <!-- Sender & Recipient Box -->
      <rect x="56" y="278" width="448" height="195" fill="none" stroke="#334155" stroke-width="1.5"/>
      <text x="72" y="306" font-family="Sarabun, sans-serif" font-size="14" fill="#475569">ผู้ส่ง (From): <tspan font-weight="bold" fill="#0f172a">QueenCosy โรงงานผลิตโซฟา (ปทุมธานี)</tspan></text>
      <line x1="56" y1="320" x2="504" y2="320" stroke="#cbd5e1" stroke-width="1.5"/>
      <text x="72" y="350" font-family="Sarabun, sans-serif" font-size="16" font-weight="bold" fill="#1e3a8a">ผู้รับ (To): ${customerName}</text>
      <text x="72" y="382" font-family="Sarabun, sans-serif" font-size="16" fill="#1e293b">จังหวัดปลายทาง: <tspan font-weight="bold" font-size="20" fill="#b91c1c">${province}</tspan></text>
      <text x="72" y="420" font-family="Inter, Sarabun, sans-serif" font-size="15" font-weight="bold" fill="#0f172a">Order ID: ${orderId}</text>
      <text x="72" y="452" font-family="Sarabun, sans-serif" font-size="13" fill="#047857" font-weight="bold">✓ ติดบนสินค้าจริง: โซฟาห่อบับเบิ้ลกันกระแทกเรียบร้อย</text>

      <!-- SKU & Item Details Table -->
      <rect x="56" y="488" width="448" height="170" fill="#f8fafc" stroke="#334155" stroke-width="1.5"/>
      <rect x="56" y="488" width="448" height="34" fill="#1e293b"/>
      <text x="72" y="510" font-family="Sarabun, sans-serif" font-size="14" font-weight="bold" fill="#ffffff">รายการสินค้า (Seller SKU / รุ่น-สี)</text>
      <text x="485" y="510" font-family="Sarabun, sans-serif" font-size="14" font-weight="bold" fill="#ffffff" text-anchor="end">จำนวน</text>
      <text x="72" y="555" font-family="Sarabun, sans-serif" font-size="18" font-weight="bold" fill="#0f172a">${sku}</text>
      <rect x="430" y="532" width="56" height="36" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
      <text x="458" y="557" font-family="Inter, sans-serif" font-size="20" font-weight="bold" fill="#dc2626" text-anchor="middle">x${qty}</text>
      <text x="72" y="635" font-family="Sarabun, sans-serif" font-size="13" fill="#64748b">QueenCosy QC Verified Label • ถ่ายจากจุดแพ็คสินค้าขาออก</text>
    </svg>`);
  }

  function getSampleDataset(dateStr) {
    const d = dateStr || getTodayString();
    const sampleOrders = [
      {
        id: 'ORD-SMP-1',
        shipDate: d,
        orderId: '261027SPX8801A',
        trackingId: 'SPXTH06899123456A',
        cleanTracking: 'SPXTH06899123456A',
        carrier: 'Shopee Xpress (SPX)',
        platform: 'Shopee',
        sku: 'MN-ครีมลินิน (โซฟาตัวแอลมินิมอล)',
        qty: 1,
        customerName: 'คุณพิมพ์ชนก วงศ์สวัสดิ์',
        province: 'กรุงเทพมหานคร'
      },
      {
        id: 'ORD-SMP-2',
        shipDate: d,
        orderId: '579881234567890102',
        trackingId: 'TH010168A99881B',
        cleanTracking: 'TH010168A99881B',
        carrier: 'Flash Express',
        platform: 'TikTok Shop',
        sku: 'LN3-เทาเข้ม (โซฟา 3 ที่นั่งกระดุมวางแก้ว)',
        qty: 1,
        customerName: 'คุณณัฐพงศ์ เจริญสุข',
        province: 'ชลบุรี'
      },
      {
        id: 'ORD-SMP-3',
        shipDate: d,
        orderId: '579881234567890103',
        trackingId: '828991234567',
        cleanTracking: '828991234567',
        carrier: 'J&T Express',
        platform: 'TikTok Shop',
        sku: 'RC-น้ำตาลหนัง (โซฟาเบดปรับนอน)',
        qty: 1,
        customerName: 'คุณศิริพร รัตนโชติ',
        province: 'สมุทรปราการ'
      },
      {
        id: 'ORD-SMP-4',
        shipDate: d,
        orderId: '261027SPX8804D',
        trackingId: 'KEX9012345678TH',
        cleanTracking: 'KEX9012345678TH',
        carrier: 'KEX Express',
        platform: 'Shopee',
        sku: 'BS3-เขียวพาสเทล (โซฟา 3 ที่นั่งท้าวแขน)',
        qty: 1,
        customerName: 'คุณกิตติศักดิ์ แสงทอง',
        province: 'เชียงใหม่'
      },
      {
        id: 'ORD-SMP-5',
        shipDate: d,
        orderId: '880012345678905',
        trackingId: '66850998877665',
        cleanTracking: '66850998877665',
        carrier: 'BEST Express',
        platform: 'Lazada',
        sku: 'CU-ดำหนัง (เก้าอี้สตูลเหลี่ยม)',
        qty: 2,
        customerName: 'คุณอารยา สุขสมบูรณ์',
        province: 'นนทบุรี'
      }
    ];

    // Simulate QR scans from daily-parcel-checker (Items 1, 2, 4 scanned QR; Item 3 forgot QR; Item 5 pending)
    const sampleQrScans = [
      {
        id: 'QR-SMP-1',
        scanDate: d,
        scanTime: '10:15:22',
        trackingId: 'SPXTH06899123456A',
        cleanTracking: 'SPXTH06899123456A',
        scanner: 'มือถือจุดโหลด 1',
        source: 'กล้องมือถือ',
        matchedOrderId: '261027SPX8801A',
        matchedSku: 'MN-ครีมลินิน (โซฟาตัวแอลมินิมอล)',
        matchedQty: 1,
        matchedCarrier: 'Shopee Xpress (SPX)',
        matchResult: 'พบในรายการส่ง'
      },
      {
        id: 'QR-SMP-2',
        scanDate: d,
        scanTime: '10:18:45',
        trackingId: 'TH010168A99881B',
        cleanTracking: 'TH010168A99881B',
        scanner: 'มือถือจุดโหลด 1',
        source: 'กล้องมือถือ',
        matchedOrderId: '579881234567890102',
        matchedSku: 'LN3-เทาเข้ม (โซฟา 3 ที่นั่งกระดุมวางแก้ว)',
        matchedQty: 1,
        matchedCarrier: 'Flash Express',
        matchResult: 'พบในรายการส่ง'
      },
      {
        id: 'QR-SMP-4',
        scanDate: d,
        scanTime: '10:25:10',
        trackingId: 'KEX9012345678TH',
        cleanTracking: 'KEX9012345678TH',
        scanner: 'ปืนสแกนคลัง',
        source: 'ปืนสแกน',
        matchedOrderId: '261027SPX8804D',
        matchedSku: 'BS3-เขียวพาสเทล (โซฟา 3 ที่นั่งท้าวแขน)',
        matchedQty: 1,
        matchedCarrier: 'KEX Express',
        matchResult: 'พบในรายการส่ง'
      }
    ];

    // Simulate Label Photo Scans (Items 1, 2 -> VERIFIED_ALL; Item 3 -> PHOTO_ONLY; Item 6 -> UNMATCHED_PHOTO)
    const sampleLabelScans = [
      {
        id: 'LBL-SMP-1',
        scanDate: d,
        scanTime: '10:14:05',
        trackingId: 'SPXTH06899123456A',
        cleanTracking: 'SPXTH06899123456A',
        orderId: '261027SPX8801A',
        cleanOrderId: '261027SPX8801A',
        carrier: 'Shopee Xpress (SPX)',
        platform: 'Shopee',
        sku: 'MN-ครีมลินิน (โซฟาตัวแอลมินิมอล)',
        productName: 'โซฟาตัวแอลมินิมอล (MN) สีครีมลินิน',
        qty: 1,
        customerName: 'คุณพิมพ์ชนก วงศ์สวัสดิ์',
        province: 'กรุงเทพมหานคร',
        sourceChannel: 'LINE_GROUP',
        senderName: 'ทีมแพ็ค (LINE กลุ่มส่งรูปพัสดุ)',
        confidence: 'HIGH',
        followUpStatus: 'IN_TRANSIT',
        currentHub: 'ศูนย์คัดแยกบางพลี',
        followUpNote: 'ขนส่งเข้ารับแล้ว กำลังเดินทางเข้าศูนย์คัดแยกบางพลี',
        checkedBy: 'แอดมินฝ้าย',
        checkedAt: '11:30',
        hasCloudImage: true,
        imageDataUrl: createSampleLabelSvg({
          carrier: 'Shopee Xpress (SPX)',
          trackingId: 'SPXTH06899123456A',
          orderId: '261027SPX8801A',
          platform: 'Shopee',
          customerName: 'คุณพิมพ์ชนก วงศ์สวัสดิ์',
          province: 'กรุงเทพมหานคร',
          sku: 'MN-ครีมลินิน (โซฟาตัวแอลมินิมอล)',
          qty: 1,
          sortCode: 'BKK-SPX-01'
        })
      },
      {
        id: 'LBL-SMP-2',
        scanDate: d,
        scanTime: '10:17:30',
        trackingId: 'TH010168A99881B',
        cleanTracking: 'TH010168A99881B',
        orderId: '579881234567890102',
        cleanOrderId: '579881234567890102',
        carrier: 'Flash Express',
        platform: 'TikTok Shop',
        sku: 'LN3-เทาเข้ม (โซฟา 3 ที่นั่งกระดุมวางแก้ว)',
        productName: 'โซฟา 3 ที่นั่งกระดุมวางแก้ว (LN3) สีเทาเข้ม',
        qty: 1,
        customerName: 'คุณณัฐพงศ์ เจริญสุข',
        province: 'ชลบุรี',
        sourceChannel: 'LINE_GROUP',
        senderName: 'ทีมแพ็ค (LINE กลุ่มส่งรูปพัสดุ)',
        confidence: 'HIGH',
        followUpStatus: 'OUT_FOR_DELIVERY',
        currentHub: 'สาขาเมืองชลบุรี',
        followUpNote: 'พนักงานขนส่งโทรนัดลูกค้าแล้ว กำลังนำจ่ายวันนี้',
        checkedBy: 'แอดมินฝ้าย',
        checkedAt: '11:35',
        hasCloudImage: true,
        imageDataUrl: createSampleLabelSvg({
          carrier: 'Flash Express',
          trackingId: 'TH010168A99881B',
          orderId: '579881234567890102',
          platform: 'TikTok Shop',
          customerName: 'คุณณัฐพงศ์ เจริญสุข',
          province: 'ชลบุรี',
          sku: 'LN3-เทาเข้ม (โซฟา 3 ที่นั่งกระดุมวางแก้ว)',
          qty: 1,
          sortCode: 'CBI-FL-09'
        })
      },
      {
        id: 'LBL-SMP-3',
        scanDate: d,
        scanTime: '10:21:12',
        trackingId: '828991234567',
        cleanTracking: '828991234567',
        orderId: '579881234567890103',
        cleanOrderId: '579881234567890103',
        carrier: 'J&T Express',
        platform: 'TikTok Shop',
        sku: 'RC-น้ำตาลหนัง (โซฟาเบดปรับนอน)',
        productName: 'โซฟาเบดปรับนอน (RC) สีน้ำตาลหนัง',
        qty: 1,
        customerName: 'คุณศิริพร รัตนโชติ',
        province: 'สมุทรปราการ',
        sourceChannel: 'LINE_GROUP',
        senderName: 'ทีมแพ็ค (LINE กลุ่มส่งรูปพัสดุ)',
        confidence: 'HIGH',
        followUpStatus: 'PENDING_PICKUP',
        currentHub: 'คลังสินค้า QueenCosy',
        followUpNote: 'ถ่ายรูปติดลาเบลแล้ว รอตามยิง QR ก่อนขึ้นรถ',
        checkedBy: '',
        checkedAt: '',
        hasCloudImage: true,
        imageDataUrl: createSampleLabelSvg({
          carrier: 'J&T Express',
          trackingId: '828991234567',
          orderId: '579881234567890103',
          platform: 'TikTok Shop',
          customerName: 'คุณศิริพร รัตนโชติ',
          province: 'สมุทรปราการ',
          sku: 'RC-น้ำตาลหนัง (โซฟาเบดปรับนอน)',
          qty: 1,
          sortCode: 'SPK-JT-04'
        })
      }
    ];

    return {
      orders: sampleOrders,
      qrScans: sampleQrScans,
      labelScans: sampleLabelScans
    };
  }

  return {
    DEFAULT_SUPABASE_URL,
    DEFAULT_SUPABASE_KEY,
    DEFAULT_GEMINI_MODEL,
    FOLLOW_UP_UPDATES: FOLLOW_UP_STATUSES,
    FOLLOW_UP_STATUSES,
    QUEENCOSY_SKU_CATALOG,
    getTodayString,
    adjustDateString,
    formatThaiDateDisplay,
    normalizeTracking,
    normalizeOrderId,
    detectCarrier,
    detectPlatform,
    getCarrierTrackingUrl,
    deduplicateOrderArray,
    deduplicateLabelScans,
    reconcileThreeWayStatus,
    scanLabelImageWithGemini,
    normalizeExtractedLabelData,
    getLocalConfig,
    saveLocalConfig,
    fetchCloudConfig,
    saveCloudConfig,
    saveLabelImageToCloud,
    fetchLabelImage,
    saveLabelScansToCloud,
    saveExtraOrdersToCloud,
    syncDailyDataFromCloud,
    recordIncomingLabelScan,
    fetchMultiDayDataFromCloud,
    parseOrderRows,
    parseCarrierStatusRows,
    createSampleLabelSvg,
    getSampleDataset
  };
});
