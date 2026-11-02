// Verschickt die Erinnerungen der Geschenke-App über GitHub Actions (.github/workflows/erinnerung.yml, stündlich):
//  • Adventskalender: berechnet aus den gemeinsamen Daten – mit derselben Logik wie die App
//    (Abschnitte @core-start/@core-end aus index.html, damit App und Nachricht nie auseinanderlaufen)
//  • Termine aus „Meine Geschenke“: hat jedes Gerät selbst berechnet und verschlüsselt abgelegt;
//    nur dieses Skript kann sie mit dem privaten VAPID-Schlüssel entschlüsseln.
'use strict';
const fs = require('fs');
const vm = require('vm');
const nodeCrypto = require('crypto');
const webpush = require('web-push');

const FORCE = process.env.FORCE === 'true';   // manueller Testlauf: sofort an alle eingeschalteten Geräte
const FAMILY_CODE = process.env.FAMILY_CODE;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const MAX_DELAY_HOURS = 3;                    // verspätete Läufe holen höchstens so viel nach

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadCore(){
  const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
  const code = [...html.matchAll(/\/\* @core-start[\s\S]*?\*\/([\s\S]*?)\/\* @core-end \*\//g)].map(m => m[1]).join('\n');
  const ctx = vm.createContext({state: null});
  vm.runInContext(code, ctx);
  // const-Werte sind keine Eigenschaften des Kontexts – daher explizit herausreichen
  const api = vm.runInContext('({today, VAPID_PUBLIC, buildAdvent})', ctx);
  return {...api, setState: s => { ctx.state = s; }};
}

// Verbindungscode aus der App (Link mit #join=… oder nur der Code)
function decodeFamilyCode(code){
  const s = code.trim().replace(/^.*join=/, '').replace(/-/g, '+').replace(/_/g, '/');
  const d = JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
  if (!d.c || !d.c.databaseURL || !d.f) throw new Error('FAMILY_CODE ist ungültig – bitte in der App unter ⚙ → „Weitere Person verbinden“ neu kopieren.');
  return {config: d.c, family: d.f};
}

// Anonym bei Firebase anmelden (wie die App) und Zugriff auf die gemeinsamen Daten bereitstellen
async function connect(config, family){
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${config.apiKey}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({returnSecureToken: true}),
  });
  const auth = await res.json();
  if (!auth.idToken) throw new Error('Anmeldung bei Firebase fehlgeschlagen: ' + (auth.error && auth.error.message));
  const base = `${config.databaseURL.replace(/\/$/, '')}/geschenke/${family}`;
  const q = `.json?auth=${auth.idToken}`;
  return {
    async get(){
      const data = await (await fetch(base + q)).json();
      if (data && data.error) throw new Error('Datenbank: ' + data.error);
      return data || {};
    },
    patch: (path, obj) => fetch(`${base}/${path}${q}`, {method: 'PATCH', body: JSON.stringify(obj)}),
    remove: path => fetch(`${base}/${path}${q}`, {method: 'DELETE'}),
  };
}

// Gegenstück zu sealForServer() in index.html: ECDH (privater VAPID-Schlüssel) → SHA-256 → AES-GCM
function unseal(enc){
  const ecdh = nodeCrypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(VAPID_PRIVATE_KEY, 'base64url'));
  const key = nodeCrypto.createHash('sha256').update(ecdh.computeSecret(Buffer.from(enc.epk, 'base64url'))).digest();
  const buf = Buffer.from(enc.ct, 'base64url');
  const dec = nodeCrypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64url'));
  dec.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([dec.update(buf.subarray(0, buf.length - 16)), dec.final()]).toString('utf8'));
}
function privateMessages(dev, td){
  if (!dev.enc) return [];
  try {
    return unseal(dev.enc).filter(r => r.d === td).map((r, i) => ({title: r.t, body: r.b, tag: 'termin-' + i, url: './?view=mine'}));
  } catch(e){
    console.error('Private Termine eines Geräts konnten nicht gelesen werden (passt VAPID_PRIVATE_KEY?):', e.message);
    return [];
  }
}

// Nachricht an ein Gerät; abgelaufene Anmeldungen werden entfernt
async function send(db, id, dev, payload){
  try {
    await webpush.sendNotification(dev.sub, JSON.stringify(payload), {TTL: 6 * 3600, urgency: 'high'});
    return 'ok';
  } catch(e){
    if (e.statusCode === 404 || e.statusCode === 410){
      await db.remove(`push/${id}`);
      console.log('Ein abgelaufenes Gerät wurde entfernt (Erinnerungen dort neu einschalten).');
      return 'gone';
    }
    console.error('Senden fehlgeschlagen:', e.statusCode || '', e.body || e.message);
    return 'error';
  }
}

async function main(){
  if (!FAMILY_CODE || !VAPID_PRIVATE_KEY) throw new Error('Die Secrets FAMILY_CODE und VAPID_PRIVATE_KEY fehlen (Anleitung, Teil 5).');
  const core = loadCore();
  webpush.setVapidDetails('https://github.com/', core.VAPID_PUBLIC, VAPID_PRIVATE_KEY);

  // Der Zeitplan startet kurz vor der vollen Stunde – bis :00 warten, damit die Nachricht pünktlich kommt
  const now = new Date();
  if (!FORCE && now.getMinutes() >= 45) await sleep(((60 - now.getMinutes()) * 60 - now.getSeconds()) * 1000 + 3000);

  const {config, family} = decodeFamilyCode(FAMILY_CODE);
  const db = await connect(config, family);
  const data = await db.get();
  core.setState({settings: data.settings || {}, advent: data.advent || {}, adventYears: data.adventYears || {}});
  const td = core.today(), hour = new Date().getHours();

  let sent = 0;
  for (const [id, dev] of Object.entries(data.push || {})){
    if (!dev || !dev.sub) continue;
    const due = FORCE || (dev.sent !== td && hour >= dev.hour && hour - dev.hour <= MAX_DELAY_HOURS);
    if (!due) continue;
    const msgs = [...core.buildAdvent(dev.person, td), ...privateMessages(dev, td)];
    if (FORCE && !msgs.length) msgs.push({title: '🎁 Geschenke', body: 'Test: Erinnerungen kommen an. Heute steht nichts an.', tag: 'test', url: './'});
    let gone = false;
    for (const m of msgs){
      const r = await send(db, id, dev, m);
      if (r === 'ok') sent++;
      if (r === 'gone'){ gone = true; break; }
    }
    if (!FORCE && !gone) await db.patch(`push/${id}`, {sent: td});   // heute erledigt – auch wenn nichts anstand
  }
  console.log(`${sent} Nachricht(en) verschickt.`);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
