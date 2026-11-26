import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory } from '../src/main/memory.js';
import { stem, terms, isStanding } from '../src/main/relevance.js';
import { Settings } from '../src/main/store.js';
import { Skills } from '../src/main/skills.js';
import { builtinTools } from '../src/main/tools.js';
import { Agent } from '../src/main/agent.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-rel-'));
const labels = (hits) => hits.map((h) => h.node.label);

function sample(dir = tmp()) {
  const m = new Memory(dir);
  m.createProject('Volleyball', 'The under-fourteen team the user coaches.');
  m.merge({ project: 'Volleyball', nodes: [
    { label: 'Maya', type: 'person', summary: 'Maya is the setter.' },
    { label: 'Butterfly Drill', type: 'topic', summary: 'A passing drill the team found boring.' },
    { label: 'Drill Decision', type: 'fact', summary: 'Decided to drop the butterfly drill for three-person passing.' },
    { label: 'Thursday Practice', type: 'fact', summary: 'Practice is on Thursdays at the rec center.' },
  ], links: [{ from: 'Drill Decision', to: 'Butterfly Drill', relation: 'replaces' }] });
  m.merge({ project: 'Lisbon Trip', nodes: [
    { label: 'Hotel in Alfama', type: 'fact', summary: 'Booked a small hotel in Alfama.' },
    { label: 'Ramiro', type: 'topic', summary: 'Ramiro is a seafood restaurant in Lisbon.' },
  ] });
  m.merge({ project: 'Family', nodes: [
    { label: 'Ana', type: 'person', summary: "Ana is the user's sister; she lives in Porto." },
    { label: 'Leo', type: 'person', summary: "Leo is the user's nine-year-old son." },
  ] });
  m.upsert({ label: 'Preferred Name', type: 'preference', summary: 'The user likes to be called Tom.', project: 'General' });
  m.upsert({ label: 'Coffee', type: 'preference', summary: 'The user drinks a flat white every morning.', project: 'General' });
  m.setActiveProject('Volleyball');
  return m;
}

test('relevance: words are folded so plurals and tenses meet', () => {
  assert.equal(stem('drills'), stem('drill'));
  assert.equal(stem('decided'), stem('decide'));
  assert.equal(stem('running'), stem('run'));
  assert.equal(stem('batteries'), stem('battery'));
  assert.deepEqual(terms("What's the plan for Jarvis, sir?"), ['plan']);
  assert.deepEqual(terms('Pastéis de Belém'), ['pasteis', 'de', 'belem']);
});

test('relevance: a turn gets the memories it is about, and nothing for small talk', () => {
  const m = sample();
  assert.equal(labels(m.relevant({ text: "Maya's been setting really well" }))[0], 'Maya');
  assert.ok(labels(m.relevant({ text: 'what did we decide about the drills?' })).includes('Drill Decision'));
  assert.deepEqual(labels(m.relevant({ text: 'what was that restaurant again?' })), ['Ramiro']);
  for (const smallTalk of ["what's 15% of 80?", 'tell me a joke', "what's the weather like?", 'good evening', '']) {
    assert.deepEqual(labels(m.relevant({ text: smallTalk })), [], smallTalk);
  }
  // kinship words stand in for names
  assert.ok(labels(m.relevant({ text: "how's my boy getting on?" })).includes('Leo'));
});

test('relevance: the context fills in a follow-up, and a change of subject drops it', () => {
  const m = sample();
  const context = [{ role: 'user', text: "let's talk about the Lisbon trip" }, { role: 'assistant', text: 'The hotel in Alfama is booked.' }];
  assert.ok(labels(m.relevant({ text: 'and how much was it?', context })).includes('Hotel in Alfama'));
  assert.deepEqual(labels(m.relevant({ text: 'actually, tell me a joke', context })), []);
});

test('relevance: the active project wins a tie', () => {
  const m = sample();
  m.merge({ project: 'Volleyball', nodes: [{ label: 'Budget Volleyball', type: 'fact', summary: 'The budget is 800 dollars.' }] });
  m.merge({ project: 'Lisbon Trip', nodes: [{ label: 'Budget Lisbon', type: 'fact', summary: 'The budget is 800 dollars.' }] });
  m.setActiveProject('Lisbon Trip');
  assert.equal(labels(m.relevant({ text: "what's the budget?" }))[0], 'Budget Lisbon');
  m.setActiveProject('Volleyball');
  assert.equal(labels(m.relevant({ text: "what's the budget?" }))[0], 'Budget Volleyball');
});

test('relevance: standing preferences are always on; tastes and the rest only when they bear on the turn', () => {
  const m = sample();
  m.merge({ nodes: [{ label: 'Metric Units', type: 'preference', summary: 'Prefers kilometres.', standing: true }] });
  assert.equal(m.find('Metric Units').standing, true);
  assert.equal(isStanding(m.find('Preferred Name')), true, 'a preference filed before the flag existed is recognised by what it says');
  assert.equal(isStanding(m.find('Coffee')), false);
  const notes = m.notes({ text: "what's 15% of 80?" });
  assert.match(notes, /^Standing preferences \(follow these always, unless a standing instruction above says otherwise\):\n(- (Prefers kilometres|The user likes to be called Tom)\.\n){2}Projects/);
  assert.match(notes, /Projects: Volleyball \(active\), Lisbon Trip, Family\n/);
  assert.match(notes, /Notes that may bear on this: none\./);
  for (const word of ['Maya', 'Ana', 'Ramiro', 'flat white', 'Drill']) assert.doesNotMatch(notes, new RegExp(word));
  assert.match(m.notes({ text: 'what do I drink in the morning?' }), /\[preference\] Coffee: The user drinks a flat white/);
  // a later passing mention does not undo the flag; a standing preference is not repeated among the notes
  m.merge({ nodes: [{ label: 'Metric Units', type: 'preference', summary: 'Prefers kilometres and Celsius.', standing: false }] });
  assert.equal(m.find('Metric Units').standing, true);
  assert.doesNotMatch(m.notes({ text: 'metric units' }), /\[preference\] Metric Units/);
});

test('relevance: an empty memory says so, and the notes keep to their budget', () => {
  assert.equal(new Memory(tmp()).notes({ text: 'who is Maya?' }), '(nothing remembered yet)');
  const m = sample();
  for (let i = 0; i < 30; i++) m.upsert({ label: `Serve Drill ${i}`, type: 'topic', summary: `Serve drill number ${i}, with targets and a long explanation of how the drill runs.`, project: 'Volleyball' }, { save: false });
  m._save();
  const notes = m.notes({ text: 'which serve drill?', budget: 400 });
  const section = notes.slice(notes.indexOf('Notes that may bear'));
  assert.ok(section.length < 460, `${section.length} chars`);
  assert.ok((section.match(/^- /gm) || []).length >= 2);
});

test('relevance: what is forgotten is never retrieved or recalled', async () => {
  const m = sample();
  m.saveDocument('Volleyball', 'Practice Plan', '# Practice Plan\n\nWarm up with Maya running the pepper drill.\n');
  assert.ok(labels(m.relevant({ text: 'Maya' })).includes('Maya'));
  m.forget('Maya');
  assert.equal(labels(m.relevant({ text: 'Maya' })).includes('Maya'), false);
  assert.doesNotMatch(m.notes({ text: 'how is Maya doing?' }), /\[person\] Maya/);
  assert.equal(m.search('Maya').some((n) => n.label === 'Maya'), false);
  m.forget('Lisbon Trip');
  assert.deepEqual(labels(m.relevant({ text: 'the hotel and the restaurant' })), []);
  assert.doesNotMatch(m.notes({ text: 'the hotel' }), /Lisbon|Alfama/);
});

test('recall: same scorer, more results, documents found by what they say', async () => {
  const m = sample();
  m.saveDocument('Volleyball', 'Practice Plan', '# Practice Plan\n\nFinish with the serve ladder on Lookout court.\n');
  const tools = Object.fromEntries(builtinTools({ memory: m, skills: new Skills(tmp()), settings: new Settings(tmp()), ui: () => {}, fsRoot: () => tmp(), openPath: async () => '' }).map((t) => [t.name, t]));
  assert.match(await tools.recall.run({ query: 'drills' }), /\[fact\] Drill Decision \(Volleyball\): Decided to drop the butterfly drill/);
  assert.match(await tools.recall.run({ query: 'serve ladder' }), /\[document\] Practice Plan \(Volleyball\).*Saved document; read_document opens it\./);
  assert.match(await tools.recall.run({ query: 'my son' }), /\[person\] Leo/);
  assert.match(await tools.recall.run({ query: 'submarines' }), /^Nothing in memory matches "submarines"\. Projects: General, Volleyball, Lisbon Trip, Family\.$/);
  // remember can mark a standing preference
  await tools.remember.run({ label: 'Short Answers', type: 'preference', summary: 'Keep answers short.', standing: true });
  assert.equal(m.find('Short Answers').standing, true);
});

test('agent: each turn is sent only the memories that bear on it', async () => {
  const dir = tmp();
  const memory = sample(dir);
  const settings = new Settings(dir);
  settings.set({ provider: 'local', localModel: 'test' });
  const seen = [];
  const agent = new Agent({
    settings, memory, skills: new Skills(dir), mcp: { status: () => [], tools: () => [] }, getApiKey: () => '', emit: () => {}, ui: () => {}, fsRoot: () => dir, openPath: async () => '',
  }, {
    runOllamaTurn: async (o) => { seen.push(o.system); o.emit({ type: 'delta', text: 'Right.' }); },
    extractJsonOllama: async () => null,
  });
  await agent.send('tell me a joke');
  assert.match(seen[0], /What you know\n[\s\S]*Notes that may bear on this: none\./);
  for (const word of ['Maya', 'Ana', 'Ramiro', 'Alfama', 'Drill']) assert.doesNotMatch(seen[0], new RegExp(word));
  await agent.send('what did we decide about the drills?');
  assert.match(seen[1], /\[fact\] Drill Decision \(Volleyball\)/);
  assert.doesNotMatch(seen[1], /Ana|Ramiro|Alfama/);
  // with no turn given, the latest exchange on record decides
  assert.match(agent.buildSystem().volatile, /Projects: Volleyball \(active\)/);
});

test('agent: an instruction saved or a setting changed this turn is not filed into memory too', async () => {
  const dir = tmp();
  const memory = sample(dir);
  const settings = new Settings(dir);
  settings.set({ provider: 'local', localModel: 'test' });
  const asked = [];
  const agent = new Agent({
    settings, memory, skills: new Skills(dir), mcp: { status: () => [], tools: () => [] }, getApiKey: () => '', emit: () => {}, ui: () => {}, fsRoot: () => dir, openPath: async () => '',
  }, {
    runOllamaTurn: async (o) => { if (/short/.test(o.userText)) o.emit({ type: 'tool', name: 'update_instructions' }); o.emit({ type: 'delta', text: 'Noted.' }); },
    extractJsonOllama: async (o) => { asked.push(o.user); return null; },
  });
  await agent.send('from now on keep answers short');
  await agent.send('Maya sprained her ankle');
  await new Promise((r) => setTimeout(r, 20));
  assert.match(asked[0], /saved a standing instruction; that is kept elsewhere/);
  assert.doesNotMatch(asked[1], /kept elsewhere/);
});
