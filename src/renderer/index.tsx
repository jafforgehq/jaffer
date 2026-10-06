import { render } from 'preact';
import { App } from './app';
import { bootstrap } from './state';
import './styles.css';

render(<App />, document.getElementById('root')!);
void bootstrap().catch((e) => {
  const el = document.querySelector('.boot') ?? document.getElementById('root')!;
  el.textContent = `Could not start: ${e instanceof Error ? e.message : e}`;
});

if (window.jaffer?.platform === 'darwin') document.body.classList.add('mac');
void window.jaffer?.appInfo().then((i) => ((window as unknown as { __home?: string }).__home = i.home.replace(/\/\.jaffer$/, '')));

// Test hook: lets end-to-end tests read terminal buffers. Only active with ?debug in the URL.
if (location.search.includes('debug')) {
  void import('./components/TerminalView').then((m) => ((window as unknown as { __jaffer: unknown }).__jaffer = { terminals: m.terminals }));
}
