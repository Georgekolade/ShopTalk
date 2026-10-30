/* Fetch Linea HTML source via Playwright MCP (after Cloudflare clears). */
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
setTimeout(() => { console.error('TIMEOUT'); done(3); }, 180000);

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

(async () => {
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'source', version: '1.0' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await tool('browser_navigate', { url: URL });
  await tool('browser_wait_for', { time: 15 });
  await tool('browser_navigate', { url: URL });
  await tool('browser_wait_for', { time: 5 });
  const res = await tool('browser_evaluate', {
    function: `() => document.documentElement.outerHTML`,
  });
  let html = texts(res);
  const start = html.indexOf('<!DOCTYPE') >= 0 ? html.indexOf('<!DOCTYPE') : html.indexOf('<html');
  if (start > 0) html = html.slice(start);
  fs.writeFileSync(path.join(OUT, 'linea-source.html'), html, 'utf8');
  console.log('SOURCE chars', html.length);
  console.log(html.slice(0, 1200));
  console.log('DONE');
  done(0);
})().catch((e) => { console.error(e); done(1); });
