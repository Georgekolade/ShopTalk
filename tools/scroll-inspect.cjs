/* Drive Playwright MCP: pass Cloudflare, then scroll Linea stepwise,
   screenshotting each stop so scroll animations can be inspected. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'pw-out');
fs.mkdirSync(OUT, { recursive: true });
const URL = 'https://8b.com/templates/linea/demo.html';

const proc = spawn('playwright-mcp', [], { shell: true });
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
function texts(result) {
  return (result?.result?.content || []).map((c) => c.text || '').join('\n');
}
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

async function shot(filename) {
  const res = await tool('browser_take_screenshot', { filename, fullPage: false, type: 'png' });
  for (const p of res?.result?.content || []) {
    if (p.type === 'image' && p.data) fs.writeFileSync(path.join(OUT, filename), Buffer.from(p.data, 'base64'));
  }
  console.log('SHOT', filename);
}

(async () => {
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scroll-inspect', version: '1.0' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await tool('browser_navigate', { url: URL });
  await tool('browser_wait_for', { time: 15 });
  const nav2 = await tool('browser_navigate', { url: URL });
  console.log('TITLE', texts(nav2).match(/Page Title:.*/)?.[0] || 'unknown');
  await tool('browser_wait_for', { time: 6 });

  const info = await tool('browser_evaluate', {
    function: `() => {
      const sections = [...document.querySelectorAll('main > *, body > main > section, [id]')].slice(0, 40)
        .map((el) => (el.tagName.toLowerCase()) + (el.id ? '#' + el.id : '') + ' @' + Math.round(el.getBoundingClientRect().top + window.scrollY));
      return JSON.stringify({
        gsap: typeof window.gsap !== 'undefined',
        scrollTrigger: typeof window.ScrollTrigger !== 'undefined',
        height: document.documentElement.scrollHeight,
        viewport: window.innerHeight,
        sections,
      });
    }`,
  });
  console.log('INFO', texts(info).slice(0, 2500));

  await shot('linea-s0-top.png');
  const stops = [0.12, 0.28, 0.45, 0.62, 0.8, 1.0];
  for (let i = 0; i < stops.length; i++) {
    await tool('browser_evaluate', {
      function: `(fraction) => { window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * fraction); }`,
      // playwright-mcp evaluate takes function string only; bake the value in below instead
    }).catch(() => null);
    await tool('browser_evaluate', {
      function: `() => { window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * ${stops[i]}); }`,
    });
    await tool('browser_wait_for', { time: 3 });
    await shot(`linea-s${i + 1}-${Math.round(stops[i] * 100)}.png`);
  }
  const endInfo = await tool('browser_evaluate', {
    function: `() => JSON.stringify({ y: window.scrollY, h: document.documentElement.scrollHeight })`,
  });
  console.log('END', texts(endInfo).slice(0, 300));
  console.log('DONE');
  done(0);
})().catch((e) => { console.error(e); done(1); });
