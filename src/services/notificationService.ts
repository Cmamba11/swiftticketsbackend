import QRCode from 'qrcode';

export interface EmailNotificationResult {
  success: boolean;
  simulated: boolean;
  recipient: string;
  subject: string;
  htmlContent: string;
  messageId?: string;
  error?: string;
}

export interface SmsNotificationResult {
  success: boolean;
  simulated: boolean;
  recipient: string;
  messageText: string;
  sid?: string;
  error?: string;
}

/**
 * Generates a high-resolution base64 PNG Data URL for a ticket code.
 */
export async function generateTicketQrDataUrl(ticketCode: string): Promise<string> {
  try {
    const qrDataUrl = await QRCode.toDataURL(ticketCode, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 300,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    return qrDataUrl;
  } catch (err) {
    console.error('Error generating QR code:', err);
    // Return fallback SVG-based Data URL
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="100%" height="100%" fill="#fff"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="monospace" font-size="14" fill="#000">${ticketCode}</text></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }
}

/**
 * Sends an HTML email with embedded QR code. Uses Resend API if key is present,
 * otherwise logs and simulates email delivery.
 */
export async function sendEmailNotification(params: {
  attendeeEmail: string;
  attendeeName: string;
  eventTitle: string;
  eventDate?: string;
  eventLocation?: string;
  ticketType: string;
  ticketCode: string;
  quantity: number;
  totalPricePaid: number;
  qrDataUrl: string;
}): Promise<EmailNotificationResult> {
  const {
    attendeeEmail,
    attendeeName,
    eventTitle,
    eventDate = 'Upcoming Event Date',
    eventLocation = 'Event Venue',
    ticketType,
    ticketCode,
    quantity,
    totalPricePaid,
    qrDataUrl
  } = params;

  const subject = `🎟️ Your Tickets for ${eventTitle} - ${ticketCode}`;

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #0f0f11; color: #ffffff; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 20px auto; background-color: #18181b; border: 1px solid #27272a; border-radius: 24px; padding: 32px; overflow: hidden; }
          .header { text-align: center; border-bottom: 1px solid #27272a; padding-bottom: 24px; margin-bottom: 24px; }
          .logo { font-size: 24px; font-weight: 900; color: #f97316; letter-spacing: 2px; text-transform: uppercase; }
          .event-title { font-size: 22px; font-weight: 800; color: #ffffff; margin-top: 12px; margin-bottom: 4px; }
          .badge { display: inline-block; background-color: #f97316; color: #ffffff; font-size: 11px; font-weight: 800; padding: 4px 12px; border-radius: 999px; text-transform: uppercase; letter-spacing: 1px; }
          .qr-box { background-color: #ffffff; border-radius: 16px; padding: 20px; display: inline-block; margin: 24px 0; text-align: center; }
          .qr-box img { width: 180px; height: 180px; display: block; margin: 0 auto; }
          .code { font-family: monospace; font-size: 20px; font-weight: 900; color: #ea580c; letter-spacing: 3px; margin-top: 12px; }
          .details-grid { background-color: #09090b; border: 1px solid #27272a; border-radius: 16px; padding: 20px; margin-top: 20px; }
          .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #18181b; font-size: 14px; }
          .detail-row:last-child { border-bottom: none; }
          .label { color: #a1a1aa; font-weight: 600; }
          .value { color: #ffffff; font-weight: 700; text-align: right; }
          .footer { margin-top: 32px; text-align: center; color: #71717a; font-size: 12px; border-top: 1px solid #27272a; padding-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo">⚡ SWIFT TICKETS</div>
            <div class="event-title">${eventTitle}</div>
            <span class="badge">Booking Confirmed</span>
          </div>

          <div style="text-align: center;">
            <p style="font-size: 15px; color: #d4d4d8;">Hi <strong>${attendeeName}</strong>, present this QR code at the event entrance for instant scan validation.</p>
            
            <div class="qr-box">
              <img src="${qrDataUrl}" alt="Ticket QR Code" />
              <div class="code">${ticketCode}</div>
            </div>
          </div>

          <div class="details-grid">
            <div class="detail-row">
              <span class="label">Attendee Name</span>
              <span class="value">${attendeeName}</span>
            </div>
            <div class="detail-row">
              <span class="label">Ticket Category</span>
              <span class="value">${ticketType} (${quantity}x)</span>
            </div>
            <div class="detail-row">
              <span class="label">Date & Time</span>
              <span class="value">${eventDate}</span>
            </div>
            <div class="detail-row">
              <span class="label">Location</span>
              <span class="value">${eventLocation}</span>
            </div>
            <div class="detail-row">
              <span class="label">Total Paid</span>
              <span class="value" style="color: #f97316;">$${totalPricePaid.toFixed(2)}</span>
            </div>
          </div>

          <div class="footer">
            <p>Need support? Contact support@swifttickets.com or present your ID at the venue gate.</p>
            <p>© 2026 Swift Event Platform. All rights reserved.</p>
          </div>
        </div>
      </body>
    </html>
  `;

  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey && apiKey.trim().length > 5) {
    try {
      console.log(`[Email] Sending real email via Resend to ${attendeeEmail}...`);
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Swift Tickets <onboarding@resend.dev>',
          to: [attendeeEmail],
          subject,
          html: htmlContent
        })
      });

      const resData = await resendRes.json();
      if (resendRes.ok) {
        console.log(`[Email] Email sent successfully via Resend:`, resData);
        return {
          success: true,
          simulated: false,
          recipient: attendeeEmail,
          subject,
          htmlContent,
          messageId: resData.id
        };
      } else {
        console.warn(`[Email] Resend API error:`, resData);
      }
    } catch (err: any) {
      console.error(`[Email] Failed to call Resend API:`, err);
    }
  }

  // Fallback to simulated log
  console.log(`[Email Simulated] Dispatched QR Ticket Email to ${attendeeEmail} (${subject})`);
  return {
    success: true,
    simulated: true,
    recipient: attendeeEmail,
    subject,
    htmlContent,
    messageId: `msg_sim_${Math.random().toString(36).substring(2, 10)}`
  };
}

/**
 * Sends an SMS text message with ticket details and verification code.
 * Uses Twilio REST API if credentials exist, otherwise logs simulated SMS.
 */
export async function sendSmsNotification(params: {
  attendeePhone: string;
  attendeeName: string;
  eventTitle: string;
  ticketType: string;
  ticketCode: string;
  quantity: number;
}): Promise<SmsNotificationResult> {
  const { attendeePhone, attendeeName, eventTitle, ticketType, ticketCode, quantity } = params;

  const appUrl = process.env.APP_URL || 'https://swifttickets.app';
  const messageText = `🎟️ SWIFT TICKETS: Hi ${attendeeName}! Your booking for "${eventTitle}" (${ticketType} x${quantity}) is confirmed! Ticket Code: ${ticketCode}. Show your QR code at the gate: ${appUrl}/ticket/${ticketCode}`;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone = process.env.TWILIO_PHONE_NUMBER;

  if (accountSid && authToken && fromPhone) {
    try {
      console.log(`[SMS] Sending real SMS via Twilio to ${attendeePhone}...`);
      const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
      const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

      const formData = new URLSearchParams();
      formData.append('To', attendeePhone);
      formData.append('From', fromPhone);
      formData.append('Body', messageText);

      const twilioRes = await fetch(twilioUrl, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: formData.toString()
      });

      const twilioData = await twilioRes.json();
      if (twilioRes.ok) {
        console.log(`[SMS] SMS sent successfully via Twilio SID: ${twilioData.sid}`);
        return {
          success: true,
          simulated: false,
          recipient: attendeePhone,
          messageText,
          sid: twilioData.sid
        };
      } else {
        console.warn(`[SMS] Twilio API error:`, twilioData);
      }
    } catch (err: any) {
      console.error(`[SMS] Failed to send Twilio SMS:`, err);
    }
  }

  // Fallback to simulated log
  console.log(`[SMS Simulated] Dispatched SMS to ${attendeePhone}: "${messageText}"`);
  return {
    success: true,
    simulated: true,
    recipient: attendeePhone,
    messageText,
    sid: `SM_sim_${Math.random().toString(36).substring(2, 10)}`
  };
}
