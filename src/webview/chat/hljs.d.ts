// highlight.js publishes types only for its root entry; language modules are plain JS.
declare module 'highlight.js/lib/languages/*' {
  import type { LanguageFn } from 'highlight.js';
  const language: LanguageFn;
  export default language;
}
