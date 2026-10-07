import { describe, expect, it } from 'vitest';
import { bm25, jaccard, overlap, similarity, stem, tokenize, tokenSet } from '../src/core/memory/text';

describe('stem', () => {
  it('strips the common English endings, only from words long enough to keep a stem', () => {
    expect(stem('running')).toBe('runn');
    expect(stem('tested')).toBe('test');
    expect(stem('boxes')).toBe('box');
    expect(stem('tests')).toBe('test');
    expect(stem('sing')).toBe('sing'); // too short for -ing
    expect(stem('bed')).toBe('bed'); // too short for -ed
    expect(stem('class')).toBe('class'); // -ss is not a plural
    expect(stem('css')).toBe('css');
  });
});

describe('tokenize', () => {
  it('lower-cases, drops stop words and one-letter words, and stems', () => {
    expect(tokenize('The tests were Running in the CI')).toEqual(['test', 'runn', 'ci']);
    expect(tokenize('a b c')).toEqual([]);
    expect(tokenize('')).toEqual([]);
  });

  it('keeps what makes a technical term itself: c++, c#, node.js, snake_case, kebab-case', () => {
    const t = tokenize('Prefers C++ and C# over node.js, snake_case over kebab-case');
    expect(t).toHaveLength(6);
    expect(t.slice(0, 3)).toEqual(['prefer', 'c++', 'c#']);
    expect(t[3]).toMatch(/^node\.js?$/); // one token, dot kept (the stemmer may take the plural-looking s off, the same way for a query)
    expect(t.slice(4)).toEqual(['snake_case', 'kebab-case']);
    // whatever the stemmer does, a query written the same way finds it
    expect(bm25([{ id: 'a', text: 'We run node.js 22 in production' }], 'node.js')[0]?.id).toBe('a');
  });

  it('trims dots and dashes around a word, and splits on everything else', () => {
    expect(tokenize('--verbose... (see: docs/guide.md)')).toEqual(['verbose', 'see', 'doc', 'guide.md']);
  });
});

describe('set similarity', () => {
  const s = (t: string) => tokenSet(t);

  it('jaccard is the shared part of the whole, 0 for nothing in common or an empty side', () => {
    expect(jaccard(s('pnpm workspace'), s('pnpm workspace'))).toBe(1);
    expect(jaccard(s('pnpm workspace'), s('yarn monorepo'))).toBe(0);
    expect(jaccard(s('pnpm workspace root'), s('pnpm workspace'))).toBeCloseTo(2 / 3, 6);
    expect(jaccard(new Set(), s('pnpm'))).toBe(0);
    expect(jaccard(s('pnpm'), new Set())).toBe(0);
  });

  it('overlap forgives a short restatement of a longer text, where jaccard would not', () => {
    const long = s('always run the database migrations before the integration tests in this repository');
    const short = s('run migrations before integration tests');
    expect(overlap(short, long)).toBe(1);
    expect(jaccard(short, long)).toBeLessThan(0.6);
    expect(overlap(new Set(), long)).toBe(0);
  });

  it('similarity takes the better of the two, discounting the overlap reading', () => {
    expect(similarity('Prefers pnpm', 'prefers pnpm')).toBe(1);
    expect(similarity('Use vitest', 'Deploy on Fridays')).toBe(0);
    const long = 'always run the database migrations before the integration tests in this repository';
    expect(similarity('run migrations before integration tests', long)).toBeCloseTo(0.9, 6);
  });
});

describe('bm25', () => {
  const docs = [
    { id: 'pm', text: 'Uses pnpm workspaces; never run npm install in the monorepo' },
    { id: 'test', text: 'Run the vitest suite with npm test before pushing' },
    { id: 'deploy', text: 'Deploys go out through the release script on Fridays' },
  ];

  it('ranks the document that matches the query first and leaves out those that match nothing', () => {
    const r = bm25(docs, 'pnpm workspaces');
    expect(r.map((x) => x.id)).toEqual(['pm']);
    const t = bm25(docs, 'vitest tests');
    expect(t[0]!.id).toBe('test');
    expect(t.every((x) => x.score > 0)).toBe(true);
  });

  it('a rare term counts for more than a common one', () => {
    const corpus = [
      { id: 'a', text: 'the build uses esbuild' },
      { id: 'b', text: 'the build is fast' },
      { id: 'c', text: 'the build is cached' },
    ];
    const r = bm25(corpus, 'build esbuild');
    expect(r[0]!.id).toBe('a');
    expect(r[0]!.score).toBeGreaterThan(r[1]!.score * 1.5);
  });

  it('a short, focused note outranks a long one that mentions the term once', () => {
    const corpus = [
      { id: 'short', text: 'Always lint before committing' },
      { id: 'long', text: `${'Lots of unrelated words about deployment and weather and lunch. '.repeat(10)}Also lint.` },
    ];
    expect(bm25(corpus, 'lint')[0]!.id).toBe('short');
  });

  it('has nothing to rank without a query, without documents, or with a query of only stop words', () => {
    expect(bm25(docs, '')).toEqual([]);
    expect(bm25(docs, 'the and of')).toEqual([]);
    expect(bm25([], 'pnpm')).toEqual([]);
  });

  it('asking for a word twice does not count it twice', () => {
    expect(bm25(docs, 'pnpm pnpm pnpm')[0]!.score).toBeCloseTo(bm25(docs, 'pnpm')[0]!.score, 9);
  });
});
