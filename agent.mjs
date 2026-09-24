#!/usr/bin/env node
import readline from 'node:readline';

const { KUUMIRC_URL, KUUMIRC_USER: user, KUUMIRC_PASSWORD: password, KUUMIRC_CHANNEL: channel = '#lobby' } = process.env;
if (!KUUMIRC_URL || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(user || '') || !password || /[\r\n]/.test(password) || !/^#[^\s,\x00-\x1f]{1,63}$/.test(channel)) {
  console.error('Set KUUMIRC_URL, KUUMIRC_USER, KUUMIRC_PASSWORD, and optionally KUUMIRC_CHANNEL.');
  process.exit(1);
}

const url = new URL(KUUMIRC_URL);
if (url.protocol === 'https:') url.protocol = 'wss:';
else if (url.protocol === 'http:') url.protocol = 'ws:';
if (!['wss:', 'ws:'].includes(url.protocol)) throw new Error('Unsupported IRC URL');
url.pathname = '/socket';
url.search = '';
url.hash = '';

const socket = new WebSocket(url, 'text.ircv3.net');
const wanted = ['draft/chathistory', 'batch', 'server-time', 'message-tags', 'echo-message'];
const available = new Set();
let history = '';
let ready = false;
let hasHistory = false;
const print = event => console.log(JSON.stringify(event));

function parse(line) {
  const tags = {};
  if (line.startsWith('@')) {
    const end = line.indexOf(' ');
    for (const tag of line.slice(1, end).split(';')) {
      const equal = tag.indexOf('=');
      tags[tag.slice(0, equal < 0 ? undefined : equal)] = equal < 0 ? '' : tag.slice(equal + 1);
    }
    line = line.slice(end + 1);
  }
  let nick = '';
  if (line.startsWith(':')) {
    const end = line.indexOf(' ');
    nick = line.slice(1, end).split('!')[0];
    line = line.slice(end + 1);
  }
  const trailing = line.indexOf(' :');
  const parts = (trailing < 0 ? line : line.slice(0, trailing)).split(' ');
  if (trailing >= 0) parts.push(line.slice(trailing + 2));
  return { command: parts.shift(), parts, nick, tags };
}

socket.addEventListener('open', () => {
  socket.send('CAP LS 302');
  socket.send(`PASS :${password}`);
  socket.send(`NICK ${user}`);
  socket.send(`USER ${user}/local@agent-${process.pid} 0 * :Agent`);
});
socket.addEventListener('message', event => {
  const { command, parts, nick, tags } = parse(String(event.data));
  if (command === 'CAP' && parts[1] === 'LS') {
    for (const cap of (parts.at(-1) || '').split(' ')) available.add(cap.split('=')[0]);
    if (parts[2] !== '*') {
      const request = wanted.filter(cap => available.has(cap));
      socket.send(request.length ? `CAP REQ :${request.join(' ')}` : 'CAP END');
    }
  } else if (command === 'CAP' && parts[1] === 'ACK') {
    hasHistory = (parts.at(-1) || '').split(' ').includes('draft/chathistory');
    socket.send('CAP END');
  } else if (command === 'CAP' && parts[1] === 'NAK') {
    socket.send('CAP END');
  } else if (command === 'PING') {
    socket.send(`PONG :${parts.at(-1)}`);
  } else if (command === '001') {
    socket.send(`JOIN ${channel}`);
  } else if (command === '366' && parts[1]?.toLowerCase() === channel.toLowerCase()) {
    if (hasHistory) socket.send(`CHATHISTORY LATEST ${channel} * 200`);
    else { ready = true; print({ type: 'ready', channel }); }
  } else if (command === 'BATCH' && parts[0]?.startsWith('+') && parts[1] === 'chathistory') {
    history = parts[0].slice(1);
  } else if (command === 'BATCH' && parts[0] === `-${history}` && history) {
    history = '';
    ready = true;
    print({ type: 'ready', channel });
  } else if (command === 'PRIVMSG' && parts[0]?.toLowerCase() === channel.toLowerCase()) {
    print({ type: 'message', channel, nick, text: parts[1] || '', time: tags.time || null, id: tags.msgid || null, history: !!tags.batch });
  } else if (command === 'ERROR' || command === 'FAIL') {
    console.error(parts.at(-1) || 'IRC error');
  }
});
socket.addEventListener('error', () => console.error('IRC WebSocket failed'));
socket.addEventListener('close', () => {
  print({ type: 'disconnected' });
  process.exitCode = 1;
  input.close();
});

const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  try {
    const { text } = JSON.parse(line);
    if (!ready || typeof text !== 'string' || !text.trim() || /[\r\n]/.test(text) || new TextEncoder().encode(`PRIVMSG ${channel} :${text}`).length > 510) throw new Error('not ready or invalid message');
    socket.send(`PRIVMSG ${channel} :${text}`);
  } catch (error) {
    console.error(error.message);
  }
});
