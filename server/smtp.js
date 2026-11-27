// Minimale SMTP-client (SSL op poort 465 of STARTTLS op 587) zonder externe pakketten.
// Wordt enkel gebruikt als SMTP_HOST ingesteld is. Een mislukte mail blokkeert nooit een boeking.
const tls = require('tls');
const net = require('net');

function smtpConfig(env = process.env) {
  if (!env.SMTP_HOST) return null;
  return {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 465),
    secure: env.SMTP_SECURE ? env.SMTP_SECURE !== 'false' : Number(env.SMTP_PORT || 465) === 465,
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || env.SMTP_USER || '',
  };
}

const _b64 = s => Buffer.from(s, 'utf8').toString('base64');
const _wrap = s => _b64(s).replace(/.{76}/g, '$&\r\n');
const _wrapBuf = buf => buf.toString('base64').replace(/.{76}/g, '$&\r\n');
const _encHeader = s => /[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${_b64(s)}?=` : s;
const _grens = () => 'bnd_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
const _buf = c => Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8');

// Bouwt het volledige RFC822-bericht (incl. afsluitende \r\n.). invite = { content, method } voegt een
// inline text/calendar;method=REQUEST deel toe (vergaderuitnodiging) én de .ics als downloadbare bijlage.
function bouwBericht(cfg, { to, subject, text, html, replyTo, cc, attachments, invite }) {
  const ccA = (Array.isArray(cc) ? cc : [cc]).map(x => String(x || '').trim()).filter(Boolean);
  const kop = [`From: ${cfg.from}`, `To: ${to}`, ccA.length ? `Cc: ${ccA.join(', ')}` : null, replyTo ? `Reply-To: ${replyTo}` : null, `Subject: ${_encHeader(subject || '')}`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0'];
  const heeftInvite = !!(invite && invite.content);
  const method = (invite && invite.method) || 'REQUEST';
  if (heeftInvite) kop.push('Content-Class: urn:content-classes:calendarmessage');
  // alternative-groep: text/plain (+ text/html) (+ text/calendar;method)
  const heeftAlt = !!(html || heeftInvite);
  let altType, altBody;
  if (heeftAlt) {
    const g = _grens(); altType = `multipart/alternative; boundary="${g}"`;
    const d = [`--${g}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', _wrap(text || ''), ''];
    if (html) d.push(`--${g}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', _wrap(html), '');
    if (heeftInvite) d.push(`--${g}`, `Content-Type: text/calendar; charset=UTF-8; method=${method}`, 'Content-Transfer-Encoding: base64', '', _wrapBuf(_buf(invite.content)), '');
    d.push(`--${g}--`); altBody = d.join('\r\n');
  } else { altType = 'text/plain; charset=UTF-8'; altBody = _wrap(text || ''); }
  // bijlagen (de uitnodiging ook als downloadbare .ics)
  const att = (attachments || []).filter(a => a && a.content).slice();
  if (heeftInvite) att.push({ filename: 'afspraak.ics', content: _buf(invite.content), contentType: `text/calendar; charset=UTF-8; method=${method}` });
  let body;
  if (att.length) {
    const g = _grens(); kop.push(`Content-Type: multipart/mixed; boundary="${g}"`);
    const delen = [`--${g}`, `Content-Type: ${altType}`].concat(heeftAlt ? [] : ['Content-Transfer-Encoding: base64']).concat(['', altBody, '']);
    for (const a of att) delen.push(`--${g}`, `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${String(a.filename || 'bijlage').replace(/"/g, '')}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${String(a.filename || 'bijlage').replace(/"/g, '')}"`, '', _wrapBuf(Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content), 'base64')), '');
    delen.push(`--${g}--`); body = delen.join('\r\n');
  } else if (heeftAlt) { kop.push(`Content-Type: ${altType}`); body = 'Dit is een bericht in meerdere formaten.\r\n\r\n' + altBody; }
  else { kop.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'); body = altBody; }
  return kop.filter(l => l !== null).join('\r\n') + '\r\n\r\n' + body + '\r\n.';
}

// attachments: [{ filename, content: Buffer, contentType }] ; invite: { content: Buffer, method }
function sendMail({ to, subject, text, html, replyTo, attachments, cc, bcc, invite }, cfg = smtpConfig()) {
  if (!cfg || !cfg.from || !to) return Promise.resolve(false);
  const _lijst = v => (Array.isArray(v) ? v : [v]).map(x => String(x || '').trim()).filter(Boolean);
  const _adres = a => String(a || '').replace(/.*<|>.*/g, '').trim();
  const ccA = _lijst(cc), bccA = _lijst(bcc);
  const rcpts = [to].concat(ccA).concat(bccA).map(_adres).filter(Boolean);
  return new Promise((resolve, reject) => {
    let socket, buffer = '', step = 0, upgraded = cfg.secure, ri = 0;
    const timeout = setTimeout(() => { try { socket.destroy(); } catch (e) {} reject(new Error('SMTP timeout')); }, 20000);
    const fail = e => { clearTimeout(timeout); try { socket.destroy(); } catch (_) {} reject(e); };
    const write = s => socket.write(s + '\r\n');
    const b64 = s => Buffer.from(s, 'utf8').toString('base64');
    const message = bouwBericht(cfg, { to, subject, text, html, replyTo, cc, attachments, invite });

    const steps = [
      () => write('EHLO studio'),
      (line) => { if (!upgraded && /STARTTLS/i.test(buffer)) { write('STARTTLS'); return 'starttls'; } return auth(); },
    ];
    function auth() {
      if (cfg.user) { write('AUTH LOGIN'); return 'auth'; }
      write(`MAIL FROM:<${cfg.from.replace(/.*<|>.*/g, '')}>`); return 'mail';
    }
    let state = 'greet';
    function onLine(line) {
      const code = Number(line.slice(0, 3));
      if (code >= 400) return fail(new Error('SMTP: ' + line));
      switch (state) {
        case 'greet': write('EHLO studio'); state = 'ehlo'; break;
        case 'ehlo':
          if (!upgraded && /STARTTLS/i.test(buffer)) { write('STARTTLS'); state = 'starttls'; }
          else state = auth();
          break;
        case 'starttls': {
          const plain = socket; socket.removeAllListeners('data');
          socket = tls.connect({ socket: plain, servername: cfg.host }, () => { upgraded = true; buffer = ''; write('EHLO studio'); state = 'ehlo2'; });
          socket.on('data', onData); socket.on('error', fail); break; }
        case 'ehlo2': state = auth(); break;
        case 'auth': write(b64(cfg.user)); state = 'user'; break;
        case 'user': write(b64(cfg.pass)); state = 'pass'; break;
        case 'pass': write(`MAIL FROM:<${cfg.from.replace(/.*<|>.*/g, '')}>`); state = 'mail'; break;
        case 'mail': write(`RCPT TO:<${rcpts[0]}>`); ri = 1; state = 'rcpt'; break;
        case 'rcpt': if (ri < rcpts.length) { write(`RCPT TO:<${rcpts[ri++]}>`); } else { write('DATA'); state = 'data'; } break;
        case 'data': socket.write(message + '\r\n'); state = 'sent'; break;
        case 'sent': write('QUIT'); state = 'quit'; clearTimeout(timeout); resolve(true); break;
        case 'quit': try { socket.end(); } catch (e) {} break;
      }
    }
    function onData(chunk) {
      buffer += chunk.toString();
      // Verwerk enkel volledige, laatste regels van een antwoord (code gevolgd door spatie).
      const lines = buffer.split('\r\n');
      const complete = lines.filter(l => /^\d{3} /.test(l));
      if (!complete.length) return;
      const last = complete[complete.length - 1];
      const keep = buffer; buffer = '';
      if (state === 'ehlo' || state === 'ehlo2') buffer = keep; // EHLO-antwoord bevat de capabilities (STARTTLS)
      onLine(last);
      if (state !== 'starttls') buffer = '';
    }
    socket = cfg.secure ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }) : net.connect({ host: cfg.host, port: cfg.port });
    socket.on('data', onData);
    socket.on('error', fail);
  });
}

module.exports = { sendMail, smtpConfig, bouwBericht };
