import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import JSZip from 'jszip';
import sharp from 'sharp';
import { kindOf, isTextual, mimeOf } from '../src/main/filekind.js';
import { extractText, canExtract, describeModel, imageSize } from '../src/main/extract.js';
import { toolResult, transcriptText } from '../src/main/tools.js';
import { resultContent } from '../src/main/llm/anthropic.js';
import { mcpContent } from '../src/main/llm/claudecli.js';
import { toolMessage } from '../src/main/llm/ollama.js';
import { Memory } from '../src/main/memory.js';
import { Settings } from '../src/main/store.js';
import { Skills } from '../src/main/skills.js';
import { Agent } from '../src/main/agent.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-files-'));
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
});
const readBody = async (req) => { let b = ''; for await (const c of req) b += c; return JSON.parse(b); };

// ---- tiny documents, made on the spot ---------------------------------------------------------

function makePdf(pages) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  pages.forEach((text, i) => {
    const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function makeDocx(paras) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return z.generateAsync({ type: 'nodebuffer' });
}

function makeXlsx() {
  const z = new JSZip();
  z.file('xl/workbook.xml', '<workbook><sheets><sheet name="Scores" sheetId="1"/><sheet name="Notes" sheetId="2"/></sheets></workbook>');
  z.file('xl/sharedStrings.xml', '<sst><si><t>name</t></si><si><t>score</t></si><si><t>Ana &amp; Bo</t></si><si><r><t>rich </t></r><r><t>text</t></r></si></sst>');
  z.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>12</v></c></row></sheetData></worksheet>');
  z.file('xl/worksheets/sheet2.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>3</v></c><c r="B1" t="inlineStr"><is><t>a, b</t></is></c></row></sheetData></worksheet>');
  return z.generateAsync({ type: 'nodebuffer' });
}

function makePptx(slides) {
  const z = new JSZip();
  slides.forEach((lines, i) => z.file(`ppt/slides/slide${i + 1}.xml`, `<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>${lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join('')}</p:spTree></p:cSld></p:sld>`));
  return z.generateAsync({ type: 'nodebuffer' });
}

const png = (width, height) => sharp({ create: { width, height, channels: 3, background: '#ff8800' } }).png().toBuffer();

function makeAgent(root, extra = {}, settingsPatch = {}) {
  const dir = tmp();
  const settings = new Settings(dir);
  settings.set(settingsPatch);
  const memory = new Memory(dir);
  const ui = [];
  const events = [];
  const agent = new Agent({
    settings, memory, skills: new Skills(dir),
    mcp: { status: () => [], tools: () => [] },
    getApiKey: () => 'test-key', emit: (e) => events.push(e), ui: (e) => ui.push(e),
    fsRoot: () => root, openPath: async () => '', ...extra,
  });
  const tools = Object.fromEntries(agent.tools().map((t) => [t.name, t]));
  return { agent, memory, ui, events, tools, settings };
}

// ---- tests ------------------------------------------------------------------------------------

test('filekind: every kind the viewer knows, from the extension', () => {
  const cases = {
    'a/photo.JPG': 'image', 'logo.svg': 'svg', 'ship.glb': 'model', 'part.stl': 'model', 'paper.pdf': 'pdf',
    'notes.md': 'markdown', 'main.rs': 'code', 'run.log': 'text', 'data.tsv': 'csv', 'x.geojson': 'json',
    'song.flac': 'audio', 'clip.mov': 'video', 'report.docx': 'office', 'page.htm': 'html', 'archive.zip': 'other',
    'C:\\Users\\me\\README': 'text', '/home/me/.bashrc': 'other', 'noext': 'other',
  };
  for (const [p, kind] of Object.entries(cases)) assert.equal(kindOf(p), kind, p);
  assert.equal(isTextual('a.json'), true);
  assert.equal(isTextual('a.png'), false);
  assert.equal(mimeOf('a.mp4'), 'video/mp4');
  assert.equal(mimeOf('a.py'), 'text/plain');
  assert.equal(mimeOf('a.bin'), 'application/octet-stream');
});

test('extract: text out of PDFs (by page), Word, spreadsheets, slides, web pages', async () => {
  const dir = tmp();
  const put = (name, data) => { fs.writeFileSync(path.join(dir, name), data); return path.join(dir, name); };
  const pdf = await extractText(put('two.pdf', makePdf(['Page one says hi.', 'Page two says bye.'])));
  assert.deepEqual(pdf.parts, ['Page one says hi.', 'Page two says bye.']);
  assert.equal(pdf.partName, 'page');
  assert.match(pdf.text, /\[page 2\]\nPage two says bye\./);

  const docx = await extractText(put('memo.docx', await makeDocx(['Dear team,', 'Practice moves to Friday.'])));
  assert.equal(docx.text, 'Dear team,\n\nPractice moves to Friday.');

  const xlsx = await extractText(put('scores.xlsx', await makeXlsx()));
  assert.deepEqual(xlsx.parts, ['Sheet "Scores"\nname,score\nAna & Bo,,12', 'Sheet "Notes"\nrich text,"a, b"']);

  const pptx = await extractText(put('deck.pptx', await makePptx([['Title', 'Subtitle'], ['Second slide']])));
  assert.deepEqual(pptx.parts, ['Title\nSubtitle', 'Second slide']);

  assert.equal((await extractText(put('p.html', '<html><head><title>x</title></head><body><h1>Hi</h1><p>There &amp; back</p><script>evil()</script></body></html>'))).text, 'Hi\nThere & back');
  assert.match((await extractText(put('old.doc', 'x'))).unreadable, /older \.doc format/);
  assert.match((await extractText(put('blob.bin', Buffer.from([0, 1, 2, 0])))).unreadable, /binary file/);
  assert.equal(canExtract('a.pdf') && canExtract('a.xlsx') && !canExtract('a.png') && !canExtract('a.doc'), true);
});

test('extract: a line about a 3D model from its own header', async () => {
  const dir = tmp();
  const gltf = path.join(dir, 'm.gltf');
  fs.writeFileSync(gltf, JSON.stringify({ asset: { version: '2.0', generator: 'Blender' }, meshes: [{}, {}], materials: [{}] }));
  assert.equal(await describeModel(gltf, fs.statSync(gltf).size), 'glTF model: 2 meshes, 1 materials, 0 animations, made with Blender');
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, meshes: [{}] }).padEnd(28));
  const glb = Buffer.alloc(20 + json.length);
  glb.write('glTF', 0, 'ascii'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8); glb.writeUInt32LE(json.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); json.copy(glb, 20);
  fs.writeFileSync(path.join(dir, 'm.glb'), glb);
  assert.match(await describeModel(path.join(dir, 'm.glb'), glb.length), /^binary glTF model: 1 meshes/);
  const stl = Buffer.alloc(84 + 2 * 50);
  stl.writeUInt32LE(2, 80);
  fs.writeFileSync(path.join(dir, 'm.stl'), stl);
  assert.equal(await describeModel(path.join(dir, 'm.stl'), stl.length), 'STL model (binary): 2 triangles');
  fs.writeFileSync(path.join(dir, 'm.obj'), 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  assert.equal(await describeModel(path.join(dir, 'm.obj'), 40), 'Wavefront OBJ model: 3 vertices, 1 faces');
});

test('tools: show_file puts the file in the viewer and describes it; confinement holds, symlinks included', async () => {
  const root = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(root, 'notes.md'), `# Notes\n\n${'word '.repeat(1000)}`);
  fs.writeFileSync(path.join(root, 'paper.pdf'), makePdf(['Abstract here.', 'Results there.']));
  fs.writeFileSync(path.join(root, 'pic.png'), await png(40, 30));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  fs.mkdirSync(path.join(root, 'sub'));
  const { tools, ui, memory } = makeAgent(root);

  const md = await tools.show_file.run({ path: 'notes.md' });
  assert.deepEqual(ui.at(-1), { type: 'show_file', path: path.join(root, 'notes.md') });
  assert.match(md, /^On screen: notes\.md \(markdown, 5 KB\)/);
  assert.match(md, /It begins:\n# Notes/);
  assert.match(md, /5,008 characters in all/);
  assert.match(await tools.show_file.run({ path: path.join(root, 'paper.pdf') }), /\(pdf, .*\n2 pages\.\nIt begins:\nAbstract here\.\n\nResults there\./);
  assert.match(await tools.show_file.run({ path: 'pic.png' }), /40 by 30 pixels\.\nTo see what is in it, use read_file\./);

  await assert.rejects(tools.show_file.run({ path: path.join(outside, 'secret.txt') }), /outside the folder/);
  await assert.rejects(tools.show_file.run({ path: 'link.txt' }), /outside the folder/);
  await assert.rejects(tools.read_file.run({ path: 'link.txt' }), /outside the folder/);
  await assert.rejects(tools.show_file.run({ path: 'missing.txt' }), /There is no file/);
  await assert.rejects(tools.show_file.run({ path: 'sub' }), /is a folder/);
  assert.equal(ui.filter((e) => e.type === 'show_file').length, 3, 'nothing refused reached the screen');

  // Jarvis's own documents are readable and showable too
  const { file } = memory.saveDocument(null, 'Plan', '# Plan\n\nWin.');
  assert.match(await tools.read_file.run({ path: file }), /# Plan/);
  assert.match(await tools.open_document.run({ title: 'Plan' }), /on screen in the viewer/);
  assert.deepEqual(ui.at(-1), { type: 'show_file', path: file });
});

test('tools: read_file reads documents in parts and hands images over as pictures', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'long.txt'), 'a'.repeat(45000) + 'END');
  fs.writeFileSync(path.join(root, 'paper.pdf'), makePdf(['Abstract here.', 'Results there.']));
  fs.writeFileSync(path.join(root, 'memo.docx'), await makeDocx(['Practice moves to Friday.']));
  fs.writeFileSync(path.join(root, 'small.png'), await png(40, 30));
  fs.writeFileSync(path.join(root, 'big.png'), await png(3200, 1000));
  fs.writeFileSync(path.join(root, 'talk.mp3'), 'ID3');
  const { tools } = makeAgent(root);

  const first = await tools.read_file.run({ path: 'long.txt' });
  assert.match(first, /characters 0 to 40,000 of 45,003; read_file with offset 40000 continues\)$/);
  const rest = await tools.read_file.run({ path: 'long.txt', offset: 40000 });
  assert.match(rest, /aEND\n\(end; from character 40,000\)$/);
  assert.match(await tools.read_file.run({ path: 'paper.pdf' }), /^.*paper\.pdf \(pdf, 2 pages\)\n\[page 1\]\nAbstract here\.\n\n\[page 2\]\nResults there\.$/);
  assert.match(await tools.read_file.run({ path: 'paper.pdf', page: 2 }), /, page 2\nResults there\.$/);
  assert.match(await tools.read_file.run({ path: 'paper.pdf', page: 3 }), /has no page 3/);
  assert.match(await tools.read_file.run({ path: 'memo.docx' }), /\(office\)\nPractice moves to Friday\.$/);
  assert.match(await tools.read_file.run({ path: 'talk.mp3' }), /Use transcribe_media/);

  const small = toolResult(await tools.read_file.run({ path: 'small.png' }));
  assert.match(small.text, /image, 40 by 30 pixels/);
  assert.equal(small.images[0].mediaType, 'image/png');
  assert.equal(Buffer.from(small.images[0].data, 'base64').equals(fs.readFileSync(path.join(root, 'small.png'))), true, 'a small PNG goes as it is');
  const big = toolResult(await tools.read_file.run({ path: 'big.png' }));
  assert.match(big.text, /3200 by 1000 pixels, .*shown to you at 1568 by 490/);
  assert.equal(big.images[0].mediaType, 'image/jpeg');
  const meta = await sharp(Buffer.from(big.images[0].data, 'base64')).metadata();
  assert.deepEqual([meta.width, meta.height], [1568, 490]);
});

test('providers: a picture reaches each brain in its own shape', async () => {
  const out = { text: 'pic.png: image', images: [{ mediaType: 'image/png', data: 'AAAA' }] };
  assert.deepEqual(resultContent(out), [{ type: 'text', text: 'pic.png: image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]);
  assert.equal(resultContent('plain'), 'plain');
  assert.deepEqual(mcpContent(out), [{ type: 'text', text: 'pic.png: image' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
  assert.deepEqual(mcpContent('plain'), [{ type: 'text', text: 'plain' }]);

  const shown = [];
  const { server, url } = await listen(async (req, res) => {
    const b = await readBody(req);
    shown.push(b.model);
    res.end(JSON.stringify(b.model === 'llava' ? { capabilities: ['completion', 'vision'] } : { capabilities: ['completion', 'tools'] }));
  });
  try {
    assert.deepEqual(await toolMessage('read_file', out, { baseUrl: url, model: 'llava' }), { role: 'tool', tool_name: 'read_file', content: 'pic.png: image', images: ['AAAA'] });
    const blind = await toolMessage('read_file', out, { baseUrl: url, model: 'qwen3' });
    assert.equal(blind.images, undefined);
    assert.match(blind.content, /qwen3 cannot see images/);
    await toolMessage('read_file', out, { baseUrl: url, model: 'llava' });
    assert.deepEqual(shown, ['llava', 'qwen3'], 'asked once per model');
    assert.deepEqual(await toolMessage('x', 'text', { baseUrl: url, model: 'qwen3' }), { role: 'tool', tool_name: 'x', content: 'text' });
  } finally {
    server.close();
  }
});

test('tools: transcripts are saved as documents, shown in the Text tab, and long recordings say how long first', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'paper.pdf'), makePdf(['Abstract here.', 'Results there.']));
  fs.writeFileSync(path.join(root, 'talk.wav'), 'RIFF');
  fs.writeFileSync(path.join(root, 'pic.png'), await png(10, 10));
  const probes = [];
  let duration = 20;
  let transcribed;
  const media = {
    probe: async (p) => { probes.push(p); return { duration }; },
    decode: async () => new Float32Array(16000 * duration),
  };
  const transcribe = async (audio, { signal }) => {
    transcribed = { seconds: audio.length / 16000, signal };
    return { text: 'Hello there. General Kenobi.', chunks: [{ text: ' Hello there.', timestamp: [0, 2] }, { text: ' General Kenobi.', timestamp: [41, 43] }] };
  };
  const { tools, ui, memory } = makeAgent(root, { media, transcribe, transcribeSpeed: () => 10 });

  const doc = await tools.transcribe_document.run({ path: 'paper.pdf' });
  assert.match(doc, /^Saved "paper\.pdf — transcript" \(4 words\) in project "General".*do not read it out/);
  const viewer = ui.find((e) => e.type === 'viewer_text');
  assert.deepEqual(viewer, { type: 'viewer_text', path: path.join(root, 'paper.pdf'), title: 'paper.pdf — transcript', text: '## Page 1\n\nAbstract here.\n\n## Page 2\n\nResults there.' });
  assert.match(memory.readDocument(null, 'paper.pdf — transcript').content, /Text of .*paper\.pdf\n\n## Page 1/);

  const said = await tools.transcribe_media.run({ path: 'talk.wav' });
  assert.match(said, /20 seconds of audio, 4 words/);
  assert.equal(transcribed.seconds, 20);
  assert.equal(ui.at(-1).text, '[0:00] Hello there.\n\n[0:41] General Kenobi.');
  assert.match(memory.readDocument(null, 'talk.wav — transcript').content, /\[0:41\] General Kenobi\./);

  duration = 1800;
  transcribed = null;
  assert.match(await tools.transcribe_media.run({ path: 'talk.wav' }), /talk\.wav is 30 minutes long; transcribing it here will take about 3 minutes.*confirm true/);
  assert.equal(transcribed, null, 'nothing started before the user has heard how long');
  assert.match(await tools.transcribe_media.run({ path: 'talk.wav', confirm: true }), /30 minutes of audio/);
  duration = 3 * 3600;
  assert.match(await tools.transcribe_media.run({ path: 'talk.wav', confirm: true }), /up to two hours/);

  assert.match(await tools.transcribe_media.run({ path: 'paper.pdf' }), /transcribe_document/);
  assert.match(await tools.transcribe_document.run({ path: 'pic.png' }), /read_file, then save/);
  assert.match(await tools.transcribe_document.run({ path: 'talk.wav' }), /transcribe_media/);

  // a summary or a transcript the model wrote itself goes beside its file
  assert.match(await tools.save_document.run({ title: 'pic.png — transcript', content: 'EXIT', for_file: 'pic.png' }), /viewer's Text tab/);
  assert.deepEqual(ui.at(-1), { type: 'viewer_text', path: path.join(root, 'pic.png'), title: 'pic.png — transcript', text: 'EXIT' });
  assert.match(await tools.save_document.run({ title: 'Plain', content: 'x' }), /offer to show it in the app/);
});

test('transcriptText: paragraphs every thirty seconds or so, each with its time', () => {
  assert.equal(transcriptText([
    { text: 'One.', timestamp: [0, 3] }, { text: 'Two.', timestamp: [12, 15] }, { text: '', timestamp: [20, 21] },
    { text: 'Three.', timestamp: [31, 33] }, { text: 'Four.', timestamp: [3725, 3727] },
  ]), '[0:00] One. Two.\n\n[0:31] Three.\n\n[1:02:05] Four.');
  assert.equal(transcriptText([], ' plain '), 'plain');
});

test('agent: what is on screen is in the prompt, and a picture read by a tool reaches the model', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'pic.png'), await png(20, 20));
  let onScreen = { path: path.join(root, 'pic.png'), kind: 'image', name: 'pic.png' };
  const bodies = [];
  const { server, url } = await listen(async (req, res) => {
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['vision', 'tools'] }));
    const b = await readBody(req);
    bodies.push(b);
    if (b.format) return res.end(JSON.stringify({ message: { content: '{"project":"","nodes":[],"links":[]}' } }));
    if (b.messages.at(-1).role === 'tool') res.write(`${JSON.stringify({ message: { content: 'An orange square, sir.' } })}\n`);
    else res.write(`${JSON.stringify({ message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: onScreen.path } } }] } })}\n`);
    res.end(`${JSON.stringify({ done: true })}\n`);
  });
  try {
    const { agent } = makeAgent(root, { onScreen: () => onScreen }, { provider: 'local', ollamaUrl: url, localModel: 'llava' });
    assert.match(agent.buildSystem().volatile, new RegExp(`On screen now: pic\\.png \\(image\\) at ${root.replace(/[/\\]/g, '.')}.pic\\.png`));
    assert.match(agent.buildSystem().stable, /show_file/);
    const result = await agent.send('what is this');
    assert.equal(result.text, 'An orange square, sir.');
    const tool = bodies[1].messages.at(-1);
    assert.equal(tool.role, 'tool');
    assert.equal(tool.images.length, 1);
    assert.equal(Buffer.from(tool.images[0], 'base64').equals(fs.readFileSync(path.join(root, 'pic.png'))), true);
    onScreen = null;
    assert.doesNotMatch(agent.buildSystem().volatile, /On screen now/);
  } finally {
    server.close();
  }
});

test('agent on an API key: a picture read by a tool goes back as an image block in the tool_result', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'pic.png'), await png(20, 20));
  const bodies = [];
  const sse = (res, events) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  };
  const start = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } };
  const end = (stop_reason) => [{ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' }];
  const { server, url } = await listen(async (req, res) => {
    const b = await readBody(req);
    if (!b.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: b.model, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: '{"project":"","nodes":[],"links":[]}' }] }));
    }
    bodies.push(b);
    if (Array.isArray(b.messages.at(-1).content)) {
      return sse(res, [start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Orange.' } }, { type: 'content_block_stop', index: 0 }, ...end('end_turn')]);
    }
    return sse(res, [start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: 'pic.png' }) } },
      { type: 'content_block_stop', index: 0 }, ...end('tool_use')]);
  });
  const saved = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = url;
  try {
    const { agent } = makeAgent(root, {}, { provider: 'cloud', cloudAuth: 'key', webSearch: false });
    assert.equal((await agent.send('what colour is pic.png')).text, 'Orange.');
    const result = bodies[1].messages.at(-1).content[0];
    assert.equal(result.type, 'tool_result');
    assert.equal(result.content[0].type, 'text');
    assert.match(result.content[0].text, /image, 20 by 20 pixels/);
    assert.equal(result.content[1].type, 'image');
    assert.equal(result.content[1].source.media_type, 'image/png');
    assert.equal(Buffer.from(result.content[1].source.data, 'base64').equals(fs.readFileSync(path.join(root, 'pic.png'))), true);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = saved;
    server.close();
  }
});

test('extract: picture sizes come from the header, without an image library', async () => {
  const dir = tmp();
  const write = async (name, buf) => { fs.writeFileSync(path.join(dir, name), await buf); return imageSize(path.join(dir, name)); };
  const base = () => sharp({ create: { width: 321, height: 123, channels: 3, background: '#08f' } });
  for (const [name, buf] of [['a.png', base().png().toBuffer()], ['a.jpg', base().jpeg().toBuffer()], ['a.webp', base().webp().toBuffer()], ['a.gif', base().gif().toBuffer()]]) {
    const s = await write(name, buf);
    assert.deepEqual([s.width, s.height], [321, 123], name);
  }
  assert.deepEqual(await write('a.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 48"></svg>'), { width: 64, height: 48, format: 'svg' });
  assert.deepEqual(await write('a.bin', Buffer.from('not a picture')), { width: 0, height: 0 });
});
