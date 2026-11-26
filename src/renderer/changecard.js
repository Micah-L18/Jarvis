// A finished change to Jarvis's own code, waiting for a yes: the card in the bottom-left corner
// with Apply, Show diff and Discard. Saying "yes, apply it" does the same as the button.
import { h } from './panel.js';

export function changeCard(api, { toast }) {
  const card = h('div', { id: 'change-card', hidden: true });
  document.body.append(card);
  const act = async (name, opts) => {
    try {
      const text = await api.invoke(`selfchange:${name}`, opts);
      if (typeof text === 'string') toast(text);
    } catch (err) {
      toast(err.message, true);
    }
  };
  return {
    update(status) {
      const job = status?.job;
      if (!job || job.state !== 'ready') { card.hidden = true; return; }
      card.replaceChildren(
        h('div', { class: 'cc-head' }, 'Change ready'),
        h('div', { class: 'cc-body', title: job.summary || job.request }, job.summary || job.request),
        h('div', { class: `cc-sub ${job.testsOk ? '' : 'bad'}` }, job.testsOk ? 'Builds · tests pass' : job.buildOk ? 'Tests fail' : 'Build fails'),
        h('div', { class: 'row' },
          h('button', { class: 'btn solid', onclick: () => act('apply', { anyway: !job.testsOk }) }, job.testsOk ? 'Apply' : 'Apply anyway'),
          h('button', { class: 'btn', onclick: () => act('show') }, 'Diff'),
          h('button', { class: 'btn danger', onclick: () => act('discard') }, 'Discard')),
      );
      card.hidden = false;
    },
  };
}
