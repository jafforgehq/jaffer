import type { ComponentChildren, VNode } from 'preact';
import { RELEASE_NOTES } from '../../generated/release-notes';
import { parseMd, type Inline, type MdBlock } from '../../shared/mini-md';
import { appVersion, dismissWhatsNew, unseenReleaseNotes, whatsNewAll, whatsNewOpen } from '../state';

const Inl = ({ parts }: { parts: Inline[] }): VNode => (
  <>
    {parts.map((p, n) => (p.style === 'b' ? <strong key={n}>{p.text}</strong> : p.style === 'i' ? <em key={n}>{p.text}</em> : p.style === 'code' ? <code key={n}>{p.text}</code> : p.text))}
  </>
);

/** A release note as elements (`parseMd` gives data; text is always a text node). */
function Notes({ md }: { md: string }): VNode {
  return (
    <div class="wn-body">
      {parseMd(md).map((b: MdBlock, n) =>
        b.kind === 'h' ? (
          <div key={n} class="wn-h" data-level={b.level}>
            <Inl parts={b.inline} />
          </div>
        ) : b.kind === 'p' ? (
          <p key={n}>
            <Inl parts={b.inline} />
          </p>
        ) : (
          <ul key={n}>
            {b.items.map((it, i) => (
              <li key={i}>
                <Inl parts={it} />
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

/**
 * What is new, at the top of the side panel: the release notes of the versions the person has not seen (at most 5), until Dismiss. "All
 * versions" lists every bundled version (the newest open). The notes are bundled with the app (`RELEASE_NOTES`); nothing is read or sent.
 */
export function WhatsNew(): VNode | null {
  const unseen = unseenReleaseNotes();
  if (!unseen.length && !whatsNewOpen.value) return null;
  const all = whatsNewAll.value || !unseen.length;
  const head: ComponentChildren = all ? 'All versions' : `What's new in ${unseen[0]!.version}`;
  return (
    <section class="wn-card" aria-label="What's new">
      <div class="wn-head">
        <span class="wn-title">{head}</span>
        <span class="wn-now">{appVersion.value}</span>
      </div>
      <div class="wn-scroll">
        {all
          ? RELEASE_NOTES.map((n, i) => (
              <details key={n.version} class="wn-ver" open={i === 0}>
                <summary>{n.version}</summary>
                <Notes md={n.md} />
              </details>
            ))
          : unseen.map((n) => (
              <div key={n.version} class="wn-ver">
                {unseen.length > 1 && <div class="wn-vlabel">{n.version}</div>}
                <Notes md={n.md} />
              </div>
            ))}
      </div>
      <div class="wn-actions">
        <button class="btn primary" onClick={dismissWhatsNew}>
          {unseen.length ? 'Dismiss' : 'Close'}
        </button>
        {!all && (
          <button class="btn ghost" onClick={() => (whatsNewAll.value = true)}>
            All versions
          </button>
        )}
      </div>
    </section>
  );
}
