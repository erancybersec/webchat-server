// Stand-in Evolution API for verifying the campaign rig locally.
// Accepts every /message/send* with a plausible key.id, and answers the few
// read endpoints the app calls at boot. Nothing leaves this machine.
import { createServer } from 'node:http';

let n = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = req.url ?? '';
    const json = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.startsWith('/instance/fetchInstances'))
      return json(200, [
        { name: 'Sandbox', connectionStatus: 'open', profileName: 'Sandbox Line', number: '972500000000', _count: { Message: 0, Contact: 0, Chat: 0 } },
      ]);
    if (url.startsWith('/chat/findContacts')) return json(200, []);
    if (url.startsWith('/chat/findChats')) return json(200, []);
    if (url.startsWith('/chat/findMessages'))
      return json(200, { messages: { records: [], pages: 1, currentPage: 1 } });
    if (url.startsWith('/message/send')) {
      n += 1;
      const to = (() => {
        try {
          return JSON.parse(body).number;
        } catch {
          return '?';
        }
      })();
      console.log(`send #${n} -> ${to}`);
      return json(201, { key: { id: `mock-${n}`, remoteJid: `${to}@s.whatsapp.net` } });
    }
    return json(200, {});
  });
});
server.listen(9099, '127.0.0.1', () => console.log('mock evolution on 127.0.0.1:9099'));
