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

async function resolveLineAccessToken(cloudCfg, forceRefresh = false) {
  if (!forceRefresh) {
    const existing = process.env.LINE_CHANNEL_ACCESS_TOKEN || cloudCfg.lineChannelAccessToken || '';
    if (existing) return existing;
  }

  const clientId = process.env.LINE_CHANNEL_ID || cloudCfg.lineChannelId || '';
  const clientSecret = process.env.LINE_CHANNEL_SECRET || cloudCfg.lineChannelSecret || '';
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

        let extracted = null;
        let ocrError = null;
        try {
          extracted = await TrackerDB.scanLabelImageWithGemini(base64Data, contentType, geminiApiKey, geminiModel);
        } catch (err) {
          ocrError = err;
          extracted = TrackerDB.normalizeExtractedLabelData({
            trackingId: '',
            orderId: '',
            sku: 'รอตรวจสอบรูปใบลาเบลบนหน้าเว็บ',
            confidence: 'LOW',
            notes: err.message
          });
        }

        const recordResult = await TrackerDB.recordIncomingLabelScan(extracted, imageDataUrl, {
          sourceChannel: 'LINE_GROUP',
          senderName: 'กลุ่ม LINE ส่งรูปพัสดุ'
        });

        const scan = recordResult.scan;
        const qrStatusLine = recordResult.hasQr
          ? `✅ รีเช็คตรงกับระบบยิง QR แล้ว!${recordResult.matchedQrScan && recordResult.matchedQrScan.scanTime ? ` (ยิงเมื่อ ${recordResult.matchedQrScan.scanTime} น.)` : ''}`
          : `⚠️ ถ่ายรูปลาเบลแล้ว แต่ยังไม่ได้ยิง QR ในระบบ!`;

        const orderStatusLine = recordResult.hasOrder
          ? `📋 พบในคำสั่งซื้อวันที่: ${TrackerDB.formatThaiDateDisplay(recordResult.targetDate)}`
          : `❓ ยังไม่พบในไฟล์คำสั่งซื้อวันนี้ (ระบบบันทึกรูปไว้จับคู่ให้อัตโนมัติ)`;

        const dedupNotice = recordResult.isUpdatedExisting
          ? `🔄 อัปเดตทับรายการเดิมของเลขพัสดุนี้เรียบร้อย (ไม่สร้างรายการซ้ำ)`
          : null;

        const replyLines = ocrError
          ? [
              `📸 รับรูปใบปะหน้าพัสดุเข้าคิวตรวจสอบแล้ว!`,
              `⚠️ AI อ่านตัวเลขอัตโนมัติไม่สำเร็จ (${ocrError.message.slice(0, 80)})`,
              `ระบบเก็บรูปไว้ในแท็บ "คิวตรวจสอบ AI" บนหน้าเว็บเรียบร้อยแล้วครับ`
            ]
          : [
              `📦 ตรวจเช็คใบปะหน้าพัสดุสำเร็จ!`,
              `━━━━━━━━━━━━━━`,
              `🔢 เลขพัสดุ: ${scan.trackingId || 'อ่านไม่ชัด (รอตรวจบนเว็บ)'}`,
              `🚚 ขนส่ง: ${scan.carrier || '-'} (${scan.platform || 'ทั่วไป'})`,
              `🧾 Order ID: ${scan.orderId || '-'}`,
              `🛋 สินค้า: ${scan.sku || '-'} (x${scan.qty || 1} ชิ้น)`,
              scan.customerName || scan.province
                ? `👤 ผู้รับ: ${[scan.customerName, scan.province].filter(Boolean).join(' • จ.')}`
                : null,
              `━━━━━━━━━━━━━━`,
              qrStatusLine,
              orderStatusLine,
              dedupNotice
            ].filter(Boolean);

        await replyToLine(replyToken, lineAccessToken, replyLines.join('\n'));
      }

      // =======================================================================
      // CASE 2: TEXT COMMAND IN GROUP ("เช็คยอด", "สรุปพัสดุ", "รีเช็ค")
      // =======================================================================
      else if (msg.type === 'text') {
        const text = String(msg.text || '').trim();
        if (['เช็คยอด', 'สรุปพัสดุ', 'รีเช็ค', 'สรุปวันนี้', 'เช็คพัสดุ'].includes(text)) {
          const today = TrackerDB.getTodayString();
          const daily = await TrackerDB.syncDailyDataFromCloud(today);
          const s = daily.reconciled.summary;

          const summaryLines = [
            `📊 สรุปรีเช็คพัสดุขาออกประจำวัน (${TrackerDB.formatThaiDateDisplay(today)})`,
            `━━━━━━━━━━━━━━`,
            `📋 ออเดอร์ทั้งหมด: ${s.totalOrders} พัสดุ (${s.totalUnits} ชิ้น)`,
            `🔫 ยิง QR แล้ว: ${s.qrScannedCount} พัสดุ`,
            `📸 ถ่ายรูปใบลาเบลแล้ว: ${s.labelPhotoCount} พัสดุ`,
            `━━━━━━━━━━━━━━`,
            `✅ ผ่านการรีเช็คครบ 3 ทาง: ${s.verifiedAllCount} พัสดุ`,
            s.photoOnlyCount > 0 ? `⚠️ ถ่ายรูปแล้วแต่ยังไม่ยิง QR: ${s.photoOnlyCount} พัสดุ` : null,
            s.qrOnlyCount > 0 ? `🔫 ยิง QR แล้วแต่ยังไม่มีรูปลาเบล: ${s.qrOnlyCount} พัสดุ` : null,
            s.orderPendingCount > 0 ? `⏳ ออเดอร์ค้างแพ็ค/ค้างส่ง: ${s.orderPendingCount} พัสดุ` : null,
            s.unmatchedPhotoCount > 0 ? `❓ มีรูปถ่ายแต่ยังไม่พบในไฟล์ออเดอร์: ${s.unmatchedPhotoCount} พัสดุ` : null
          ].filter(Boolean);

          await replyToLine(replyToken, lineAccessToken, summaryLines.join('\n'));
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
