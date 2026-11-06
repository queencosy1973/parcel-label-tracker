/**
 * Vercel Serverless Function: /api/webhook-line
 * QueenCosy Parcel Label AI Tracker & 3-Way QR Re-Check LINE Bot Webhook
 *
 * Workflow:
 * 1. Receives parcel label photos attached to real products from LINE Group (ทีมแพ็ค/ส่งของ).
 * 2. Extracts Tracking ID, Order ID, Carrier, Platform, Customer/Province, and SKU via Gemini Vision AI.
 * 3. Matches against daily orders & QR scans (QC_PARCEL_DATA_<date> + QC_LABEL_ORDERS_<date>).
 * 4. Enforces 1 Tracking = 1 Record per day (updates existing record if photographed again).
 * 5. Replies instantly in LINE Group using FREE replyToken (0 Baht):
 *    - Shows Tracking ID, Order ID, Carrier, SKU/Color, Qty
 *    - ✅ "รีเช็คตรงกับระบบยิง QR แล้ว" if QR was scanned
 *    - ⚠️ "ถ่ายรูปลาเบลแล้ว แต่ยังไม่ได้ยิง QR ในระบบ!" if QR is missing
 */
const TrackerDB = require('../tracker-db.js');

const DEFAULT_LINE_CHANNEL_ID = '2012237600';
const DEFAULT_LINE_CHANNEL_SECRET = '2964f7649d6233a5460a866f21f5b64b';

async function resolveLineAccessToken(cloudCfg, forceRefresh = false) {
  if (!forceRefresh) {
    const existing = process.env.LINE_CHANNEL_ACCESS_TOKEN || cloudCfg.lineChannelAccessToken || '';
    if (existing) return existing;
  }

  const clientId = process.env.LINE_CHANNEL_ID || cloudCfg.lineChannelId || DEFAULT_LINE_CHANNEL_ID;
  const clientSecret = process.env.LINE_CHANNEL_SECRET || cloudCfg.lineChannelSecret || DEFAULT_LINE_CHANNEL_SECRET;
  if (!clientId || !clientSecret) return process.env.LINE_CHANNEL_ACCESS_TOKEN || cloudCfg.lineChannelAccessToken || '';

  try {
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    });
    const res = await fetch('https://api.line.me/v2/oauth/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    if (!res.ok) return '';
    const data = await res.json();
    if (data && data.access_token) {
      await TrackerDB.saveCloudConfig({
        lineChannelId: clientId,
        lineChannelSecret: clientSecret,
        lineChannelAccessToken: data.access_token
      });
      return data.access_token;
    }
  } catch (e) {
    console.warn('Auto mint LINE token warning:', e);
  }
  return '';
}

async function replyToLine(replyToken, accessToken, textMessage) {
  if (!replyToken || !accessToken || !textMessage) return;
  try {
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        replyToken: replyToken,
        messages: [
          {
            type: 'text',
            text: textMessage
          }
        ]
      })
    });
  } catch (err) {
    console.warn('LINE reply warning:', err);
  }
}

module.exports = async function handler(req, res) {
  // Enable CORS & Health Check on GET
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Line-Signature');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'QueenCosy Parcel Label AI Tracker LINE Bot Webhook',
      endpoint: '/api/webhook-line',
      message: 'Webhook พร้อมรับรูปใบปะหน้าพัสดุจากกลุ่ม LINE เพื่อรีเช็คกับระบบยิง QR อัตโนมัติ'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const events = Array.isArray(body.events) ? body.events : [];

    // Immediately return 200 OK for LINE Developers Console "Verify" button test (empty events)
    if (events.length === 0) {
      return res.status(200).json({ ok: true, verified: true });
    }

    const cloudCfg = await TrackerDB.fetchCloudConfig();
    let lineAccessToken = await resolveLineAccessToken(cloudCfg, false);
    const geminiApiKey = process.env.GEMINI_API_KEY || cloudCfg.geminiApiKey || '';
    const geminiModel = process.env.GEMINI_MODEL || cloudCfg.geminiModel || 'gemini-flash-latest';

    for (const event of events) {
      if (!event || event.type !== 'message' || !event.message) continue;

      const msg = event.message;
      const replyToken = event.replyToken;

      // =======================================================================
      // CASE 1: IMAGE MESSAGE (รูปถ่ายใบปะหน้าพัสดุที่ติดบนสินค้าจริง)
      // =======================================================================
      if (msg.type === 'image') {
        if (!lineAccessToken) {
          continue;
        }

        // Download image content from LINE Data API (retry with refreshed token if 401)
        let imgRes = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(msg.id)}/content`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${lineAccessToken}` }
        });

        if (imgRes.status === 401) {
          lineAccessToken = await resolveLineAccessToken(cloudCfg, true);
          if (lineAccessToken) {
            imgRes = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(msg.id)}/content`, {
              method: 'GET',
              headers: { 'Authorization': `Bearer ${lineAccessToken}` }
            });
          }
        }

        if (!imgRes.ok) {
          await replyToLine(
            replyToken,
            lineAccessToken,
            `⚠️ ดึงรูปภาพใบลาเบลจาก LINE ไม่สำเร็จ (HTTP ${imgRes.status}) กรุณาตรวจสอบ Channel ID / Secret ในแท็บตั้งค่า`
          );
          continue;
        }

        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        const arrayBuf = await imgRes.arrayBuffer();
        const base64Data = Buffer.from(arrayBuf).toString('base64');
        const imageDataUrl = `data:${contentType};base64,${base64Data}`;

        let classified = null;
        let ocrError = null;
        try {
          classified = await TrackerDB.classifyAndExtractLineImageWithGemini(base64Data, contentType, geminiApiKey, geminiModel);
        } catch (err) {
          ocrError = err;
          classified = {
            imageCategory: 'PARCEL_LABEL',
            labelData: TrackerDB.normalizeExtractedLabelData({
              trackingId: '',
              orderId: '',
              sku: 'รอตรวจสอบรูปใบลาเบลบนหน้าเว็บ',
              confidence: 'LOW',
              notes: err.message
            })
          };
        }

        const lineApprovalMode = cloudCfg.lineBotPendingMode === false ? 'APPROVED' : 'PENDING_LINE';
        const lineSilentMode = Boolean(cloudCfg.lineBotSilentMode);

        // -------------------------------------------------------------------
        // SUBCASE 1A: TRUCK CLOSING / CONTAINER SEAL PHOTO (รูปรถขนส่งเข้ามารับงาน / ปิดตู้)
        // -------------------------------------------------------------------
        if (classified.imageCategory === 'TRUCK_CLOSING') {
          const truckResult = await TrackerDB.recordIncomingTruckLog(classified.truckData, imageDataUrl, {
            sourceChannel: 'LINE_GROUP',
            senderName: 'กลุ่ม LINE รายงานขนส่ง'
          });
          const t = truckResult.truckLog;

          if (!lineSilentMode) {
            const truckReplyLines = [
              `🚛 บันทึกรูปรถขนส่ง / ปิด Book งานสำเร็จ! (คันที่ ${truckResult.totalTrucksToday} ของวันนี้)`,
              `━━━━━━━━━━━━━━`,
              `🏢 ขนส่ง: ${t.carrier || 'รถขนส่งเข้ารับสินค้า'}`,
              t.truckPlate ? `🪪 ทะเบียน/รหัสตู้: ${t.truckPlate}` : null,
              t.sealNumber ? `🔒 เลขซีลล็อกตู้ (Seal): ${t.sealNumber}` : null,
              t.photoTimestamp ? `🕒 เวลาในภาพ: ${t.photoTimestamp}` : `🕒 เวลาบันทึก: ${t.logTime}`,
              `📝 รายละเอียด: ${t.estimatedBoxesNote || 'รูปรถขนส่ง/ปิดตู้'}`,
              `━━━━━━━━━━━━━━`,
              `✅ แยกเก็บในหมวด "สมุดนับรถขนส่งรายวัน" เรียบร้อย (ไม่ปนกับยอดใบลาเบลพัสดุ)`
            ].filter(Boolean);
            await replyToLine(replyToken, lineAccessToken, truckReplyLines.join('\n'));
          }
          continue;
        }

        // -------------------------------------------------------------------
        // SUBCASE 1B: OTHER / GENERAL PHOTO (รูปทั่วไปที่ไม่ใช่ใบลาเบลและไม่ใช่รูปรถขนส่ง)
        // -------------------------------------------------------------------
        if (classified.imageCategory === 'OTHER') {
          // Do not pollute parcel label counts or truck logs
          continue;
        }

        // -------------------------------------------------------------------
        // SUBCASE 1C: PARCEL SHIPPING LABEL PHOTO (รูปใบปะหน้าพัสดุ)
        // -------------------------------------------------------------------
        const extracted = classified.labelData || {};
        // Extra safety guard: if AI could not read any valid trackingId AND no valid orderId,
        // only record it in Pending queue if it actually looks like a shipping label; never pollute main counts!
        const recordResult = await TrackerDB.recordIncomingLabelScan(extracted, imageDataUrl, {
          sourceChannel: 'LINE_GROUP',
          senderName: 'กลุ่ม LINE รายงานขนส่ง',
          approvalStatus: lineApprovalMode
        });

        const scan = recordResult.scan;
        const qrStatusLine = recordResult.hasQr
          ? `✅ รีเช็คตรงกับระบบยิง QR แล้ว!${recordResult.matchedQrScan && recordResult.matchedQrScan.scanTime ? ` (ยิงเมื่อ ${recordResult.matchedQrScan.scanTime} น.)` : ''}`
          : `⚠️ ถ่ายรูปลาเบลแล้ว แต่ยังไม่ได้ยิง QR ในระบบ!`;

        const orderStatusLine = recordResult.hasOrder
          ? `📋 พบในคำสั่งซื้อวันที่: ${TrackerDB.formatThaiDateDisplay(recordResult.targetDate)}`
          : `❓ ยังไม่พบในไฟล์คำสั่งซื้อ (รอแอดมินตรวจสอบบนหน้าเว็บ)`;

        const pendingNotice = scan.approvalStatus === 'PENDING_LINE'
          ? `⏳ สถานะ: เข้าคิว "รอแอดมินกดยืนยัน (Pending)" บนหน้าเว็บ`
          : `✅ สถานะ: บันทึกขึ้นแดชบอร์ดเรียบร้อย`;

        const dedupNotice = recordResult.isUpdatedExisting
          ? `⚠️ แจ้งเตือนใบลาเบลซ้ำ! เลขพัสดุ ${scan.trackingId} เคยส่งมาแล้วเมื่อ ${scan.firstScanTime || '-'} (สแกนซ้ำรอบที่ ${(recordResult.duplicateCount || 1) + 1})`
          : null;

        // If silent mode is enabled, only reply when there is a duplicate or unmatched warning!
        if (!lineSilentMode || recordResult.isUpdatedExisting || !recordResult.hasOrder) {
          const replyLines = ocrError
            ? [
                `📸 รับรูปใบปะหน้าพัสดุเข้าคิวรอตรวจสอบ (Pending) แล้ว!`,
                `⚠️ AI อ่านตัวเลขอัตโนมัติไม่สำเร็จ (${ocrError.message.slice(0, 80)})`,
                `ระบบเก็บรูปไว้ในแท็บ "คิวตรวจสอบ AI" บนหน้าเว็บเรียบร้อยแล้วครับ`
              ]
            : [
                recordResult.isUpdatedExisting
                  ? `⚠️ แจ้งเตือน: รูปใบลาเบลซ้ำ! (รอบที่ ${(recordResult.duplicateCount || 1) + 1})`
                  : `📦 รับรูปใบปะหน้าพัสดุเข้าคิวตรวจสอบสำเร็จ!`,
                `━━━━━━━━━━━━━━`,
                `🔢 เลขพัสดุ: ${scan.trackingId || 'อ่านไม่ชัด (รอตรวจบนเว็บ)'}`,
                `🚚 ขนส่ง: ${scan.carrier || '-'} (${scan.platform || 'ทั่วไป'})`,
                `🧾 Order ID: ${scan.orderId || '-'}`,
                `🛋 สินค้า: ${scan.sku || '-'} (x${scan.qty || 1} ชิ้น)`,
                scan.customerName || scan.province
                  ? `👤 ผู้รับ: ${[scan.customerName, scan.province].filter(Boolean).join(' • จ.')}`
                  : null,
                `━━━━━━━━━━━━━━`,
                pendingNotice,
                qrStatusLine,
                orderStatusLine,
                dedupNotice
              ].filter(Boolean);

          await replyToLine(replyToken, lineAccessToken, replyLines.join('\n'));
        }
      }

      // =======================================================================
      // CASE 2: TEXT COMMAND IN GROUP ("เช็คยอด", "สรุปพัสดุ", "เช็ครถ", "สรุปวันนี้")
      // =======================================================================
      else if (msg.type === 'text') {
        const text = String(msg.text || '').trim();
        if (['เช็คยอด', 'สรุปพัสดุ', 'รีเช็ค', 'สรุปวันนี้', 'เช็คพัสดุ', 'เช็ครถ', 'สรุปรถ'].includes(text)) {
          const today = TrackerDB.getTodayString();
          const daily = await TrackerDB.syncDailyDataFromCloud(today);
          const s = daily.reconciled.summary;
          const trucks = Array.isArray(daily.truckLogs) ? daily.truckLogs : [];

          const summaryLines = [
            `📊 สรุปรีเช็คพัสดุ & รถขนส่งประจำวัน (${TrackerDB.formatThaiDateDisplay(today)})`,
            `━━━━━━━━━━━━━━`,
            `📋 ออเดอร์ทั้งหมด: ${s.totalOrders} พัสดุ (${s.totalUnits} ชิ้น)`,
            `🔫 ยิง QR แล้ว: ${s.qrScannedCount} พัสดุ`,
            `📸 ถ่ายรูปใบลาเบล (ยืนยันแล้ว): ${s.labelPhotoCount} พัสดุ`,
            s.pendingLineCount > 0 ? `⏳ รูปใบลาเบลจาก LINE รอแอดมินยืนยัน: ${s.pendingLineCount} ใบ` : null,
            s.duplicateLabelScansCount > 0 ? `⚠️ พบถ่ายรูปใบลาเบลซ้ำ: ${s.duplicateLabelScansCount} รูป` : null,
            `🚛 รถขนส่งเข้ามารับสินค้า/ปิดตู้แล้ว: ${trucks.length} คัน`,
            `━━━━━━━━━━━━━━`,
            `✅ ผ่านการรีเช็คครบ 3 ทาง: ${s.verifiedAllCount} พัสดุ`,
            s.photoOnlyCount > 0 ? `⚠️ ถ่ายรูปแล้วแต่ยังไม่ยิง QR: ${s.photoOnlyCount} พัสดุ` : null,
            s.qrOnlyCount > 0 ? `🔫 ยิง QR แล้วแต่ยังไม่มีรูปลาเบล: ${s.qrOnlyCount} พัสดุ` : null,
            s.orderPendingCount > 0 ? `⏳ ออเดอร์ค้างแพ็ค/ค้างส่ง: ${s.orderPendingCount} พัสดุ` : null,
            s.unmatchedPhotoCount > 0 ? `❓ มีรูปถ่ายแต่ยังไม่พบในไฟล์ออเดอร์: ${s.unmatchedPhotoCount} พัสดุ` : null
          ].filter(Boolean);

          await replyToLine(replyToken, lineAccessToken, summaryLines.join('\n'));
        } else if (
          text.startsWith('ค้นหา') ||
          text.startsWith('เช็ค ') ||
          /^[A-Za-z0-9]{8,24}$/.test(text)
        ) {
          const queryStr = text.replace(/^(ค้นหา|เช็ค)\s*/i, '').trim().toLowerCase();
          if (queryStr.length >= 4) {
            const today = TrackerDB.getTodayString();
            const daily = await TrackerDB.syncDailyDataFromCloud(today);
            const matched = (daily.reconciled.items || []).filter((x) =>
              (x.trackingId && x.trackingId.toLowerCase().includes(queryStr)) ||
              (x.orderId && x.orderId.toLowerCase().includes(queryStr)) ||
              (x.customerName && x.customerName.toLowerCase().includes(queryStr))
            );

            if (matched.length === 0) {
              await replyToLine(
                replyToken,
                lineAccessToken,
                `🔍 ค้นหา "${queryStr.toUpperCase()}"\n❌ ไม่พบเลขพัสดุหรือคำสั่งซื้อนี้ในระบบปัจจุบันครับ`
              );
            } else {
              const lines = [`🔍 ผลการค้นหา "${queryStr.toUpperCase()}" (พบ ${matched.length} รายการ):`];
              matched.slice(0, 5).forEach((it, idx) => {
                const stText =
                  it.threeWayStatus === 'VERIFIED_ALL'
                    ? '✅ ครบ 3 ทาง (ยิง QR + มีรูปลาเบล)'
                    : it.threeWayStatus === 'PHOTO_ONLY'
                    ? '📸 มีรูปลาเบลแล้ว (⚠️ ยังไม่ยิง QR)'
                    : it.threeWayStatus === 'QR_ONLY'
                    ? '🔫 ยิง QR แล้ว (⚠️ ยังไม่มีรูปลาเบล)'
                    : '⏳ ออเดอร์ค้างแพ็ค (ยังไม่ยิง QR / ยังไม่มีรูป)';
                lines.push(
                  `━━━━━━━━━━━━━━`,
                  `${idx + 1}) Tracking: ${it.trackingId || '-'} (${it.carrier || '-'})`,
                  `🧾 Order: ${it.orderId || '-'}`,
                  `🛋 สินค้า: ${it.sku || '-'} (x${it.qty || 1})`,
                  `📌 สถานะ: ${stText}`
                );
              });
              await replyToLine(replyToken, lineAccessToken, lines.join('\n'));
            }
          }
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Parcel Label LINE Webhook Error:', err);
    // Always return 200 to LINE so webhook is never disabled on transient errors
    return res.status(200).json({ ok: false, error: err.message });
  }
};
