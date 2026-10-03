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

function sendMail({ to, subject, text, html, replyTo }, cfg = smtpConfig()) {
  if (!cfg || !cfg.from || !to) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    let socket, buffer = '', step = 0, upgraded = cfg.secure;
    const timeout = setTimeout(() => { try { socket.destroy(); } catch (e) {} reject(new Error('SMTP timeout')); }, 20000);
    const fail = e => { clearTimeout(timeout); try { socket.destroy(); } catch (_) {} reject(e); };
    const write = s => socket.write(s + '\r\n');
    const b64 = s => Buffer.from(s, 'utf8').toString('base64');
    const wrap = s => b64(s).replace(/.{76}/g, '$&\r\n');
    const encHeader = s => /[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${b64(s)}?=` : s;
    const kop = [`From: ${cfg.from}`, `To: ${to}`, replyTo ? `Reply-To: ${replyTo}` : null, `Subject: ${encHeader(subject)}`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0'];
    let body;
    if (html) {
      const grens = 'bnd_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      kop.push(`Content-Type: multipart/alternative; boundary="${grens}"`);
      body = [
        'Dit is een bericht in meerdere formaten.', '',
        `--${grens}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(text), '',
        `--${grens}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(html), '',
        `--${grens}--`,
      ].join('\r\n');
    } else {
      kop.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
      body = wrap(text);
    }
    const message = kop.filter(l => l !== null).join('\r\n') + '\r\n\r\n' + body + '\r\n.';

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
        case 'mail': write(`RCPT TO:<${to.replace(/.*<|>.*/g, '')}>`); state = 'rcpt'; break;
        case 'rcpt': write('DATA'); state = 'data'; break;
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

module.exports = { sendMail, smtpConfig };
