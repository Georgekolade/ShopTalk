/* ShopTalk live E2E via Playwright MCP: login, pick business, assistant
   sale + confirm, dashboard screenshot. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'pw-out');
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.APP_BASE || 'http://127.0.0.1:3001';

const proc = spawn('playwright-mcp', ['--headless', '--isolated'], { shell: true });
let buf = '';
const pending = new Map();
let nextId = 1;
const done = (code) => { try { proc.kill(); } catch {} process.exit(code); };
setTimeout(() => { console.error('TIMEOUT'); done(3); }, 240000);

function send(obj) { proc.stdin.write(JSON.stringify(obj) + '\n'); }
function call(method, params) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((res) => pending.set(id, res));
}
function tool(name, args) { return call('tools/call', { name, arguments: args || {} }); }
function texts(result) { return (result?.result?.content || []).map((c) => c.text || '').join('\n'); }
proc.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
proc.stderr.on('data', (d) => process.stderr.write('[mcp] ' + d.toString()));

async function ev(fn) {
  const res = await tool('browser_evaluate', { function: fn });
  return texts(res);
}
async function shot(filename) {
  const res = await tool('browser_take_screenshot', { filename, fullPage: false, type: 'png' });
  for (const p of res?.result?.content || []) {
    if (p.type === 'image' && p.data) fs.writeFileSync(path.join(OUT, filename), Buffer.from(p.data, 'base64'));
  }
  console.log('SHOT', filename);
}
const SET_VALUE = (selector, value) => `() => {
  const el = document.querySelector('${selector}');
  if (!el) return 'missing:' + '${selector}';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '${value}');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok:' + el.value;
}`;
const CLICK_TEXT = (text) => `() => {
  const els = [...document.querySelectorAll('button, a')];
  const hit = els.find((e) => e.textContent.trim().startsWith('${text}'));
  if (!hit) return 'missing-btn:${text}';
  hit.click();
  return 'clicked:' + hit.textContent.trim().slice(0, 60);
}`;

(async () => {
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'app-e2e', version: '1.0' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  await tool('browser_navigate', { url: BASE + '/login' });
  await tool('browser_wait_for', { time: 10 });
  console.log('LOGIN pw:', await ev(SET_VALUE('input[type="password"]', 'demo1234')));
  console.log('LOGIN submit:', await ev(`() => {
    const form = document.querySelector('form');
    if (!form) return 'missing-form';
    form.requestSubmit();
    return 'requestSubmit sent';
  }`));
  await tool('browser_wait_for', { time: 8 });
  console.log('PAGE STATE:', await ev(`() => location.href + ' || ' + document.body.innerText.slice(0, 600)`));
  let snap = texts(await tool('browser_snapshot', {}));
  fs.writeFileSync(path.join(OUT, 'app-after-login.txt'), snap, 'utf8');
  console.log('AFTER LOGIN has Ada:', snap.includes("Ada"), '| has businesses:', /Your businesses|First, set up/.test(snap));
  console.log('PICK:', await ev(CLICK_TEXT("Ada")));
  await tool('browser_wait_for', { time: 5 });

  await tool('browser_navigate', { url: BASE + '/assistant' });
  await tool('browser_wait_for', { time: 4 });
  console.log('CHAT input:', await ev(SET_VALUE('input[aria-label="Message the assistant"]', 'Sell 1 garri')));
  console.log('CHAT send:', await ev(CLICK_TEXT('Send')));
  await tool('browser_wait_for', { time: 6 });
  snap = texts(await tool('browser_snapshot', {}));
  fs.writeFileSync(path.join(OUT, 'app-assistant.txt'), snap, 'utf8');
  console.log('CHAT awaiting confirm card:', /Confirm/.test(snap), '| sale text:', /Garri/.test(snap));
  await shot('app-assistant.png');
  console.log('CONFIRM:', await ev(CLICK_TEXT('Confirm')));
  await tool('browser_wait_for', { time: 6 });
  snap = texts(await tool('browser_snapshot', {}));
  console.log('CONFIRMED receipt mentioned:', /Receipt|recorded/i.test(snap));

  await tool('browser_navigate', { url: BASE + '/dashboard' });
  await tool('browser_wait_for', { time: 6 });
  snap = texts(await tool('browser_snapshot', {}));
  fs.writeFileSync(path.join(OUT, 'app-dashboard.txt'), snap, 'utf8');
  console.log('DASHBOARD has Sales:', /Sales/.test(snap), '| chart canvas:', /canvas|img/.test(snap));
  await shot('app-dashboard.png');

  await tool('browser_navigate', { url: BASE + '/setup' });
  await tool('browser_wait_for', { time: 4 });
  snap = texts(await tool('browser_snapshot', {}));
  console.log('SETUP team section:', /Team & roles/.test(snap), '| profile:', /Profile & branding/.test(snap));
  console.log('DONE');
  done(0);
})().catch((e) => { console.error(e); done(1); });
