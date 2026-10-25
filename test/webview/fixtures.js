// Fixtures for the chat harness. Each fixture returns { state, script? } where
// `script` is a list of [delayMs, message] replayed after the initial state
// (used to simulate streaming).
(function () {
  const CWD = '/Users/alex/Documents/FeBundi';
  const now = Date.now();
  let seq = 0;
  const id = (p) => `${p}-${++seq}`;

  const TINY_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAASklEQVR4nO3OsQ0AIAwDwWzJKMzKIBRQsUBcIhd+yeVLvlpztLtnt/vdFyBAgOJArmPVAwIEKA/kOlY9IECA8kCuY9UDAgQoDvQAuqitxLLe+PUAAAAASUVORK5CYII=';

  function base(overrides) {
    return Object.assign(
      {
        key: 'harness-session',
        sessionId: '7b45b8ff-0360-40e1-a5a3-b3c8d989bba3',
        cwd: CWD,
        projectName: 'FeBundi',
        branch: 'feature/checkout-coupons',
        isWorktree: false,
        title: 'Fix coupon total in checkout',
        status: 'idle',
        modelLabel: 'Opus 5.5',
        modelValue: 'opus',
        permissionMode: 'default',
        effort: 'high',
        availableEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        bookmarks: [],
        promptPresets: [
          { label: 'Worktree', prompt: 'Create a new worktree Commit as you go. Dont push. \n\n' },
          { label: 'PR', prompt: 'Open a PR and cleanup \n\n' },
          { label: 'Branch', prompt: 'Create a new branch and work on it. Commit as you go. Dont push. \n\n' },
        ],
        availableModes: ['default', 'acceptEdits', 'plan', 'auto'],
        availableModels: [
          { value: 'default', displayName: 'Default (recommended)', description: 'Sonnet 5.5 · Efficient for routine tasks' },
          { value: 'opus', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks' },
          { value: 'fable', displayName: 'Fable 5.1', description: 'For your toughest challenges' },
          { value: 'haiku', displayName: 'Haiku 5.5', description: 'Fastest for quick answers' },
        ],
        slashCommands: [
          { name: 'compact', description: 'Clear conversation history but keep a summary in context', argumentHint: '<instructions>' },
          { name: 'clear', description: 'Clear conversation history and free up context' },
          { name: 'review', description: 'Review a pull request' },
          { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation' },
          { name: 'frontend-design', description: 'Guidance for distinctive, intentional visual design (user)' },
          { name: 'security-review', description: 'Complete a security review of the pending changes on the current branch' },
          { name: 'context', description: 'Visualize current context usage' },
          { name: 'cost', description: 'Show the total cost and duration of the current session' },
        ],
        items: [],
        pending: [],
        allowBypass: false,
        canAttachImages: true,
        contextUsage: { usedTokens: 61200, maxTokens: 200000, percent: 31 },
      },
      overrides,
    );
  }

  function conversation() {
    seq = 0;
    const t0 = now - 25 * 60 * 1000;
    const editPatch = [
      {
        oldStart: 38,
        oldLines: 9,
        newStart: 38,
        newLines: 11,
        lines: [
          '   export function cartTotal(cart: Cart, coupon?: Coupon): Money {',
          '     const subtotal = sum(cart.items.map((i) => i.price * i.quantity));',
          '-    const discount = coupon ? coupon.amount : 0;',
          '-    return money(subtotal - discount + shipping(cart));',
          '+    // Percentage coupons apply to the subtotal only, never to shipping.',
          '+    const discount = coupon',
          "+      ? coupon.kind === 'percent' ? round2((subtotal * coupon.amount) / 100) : coupon.amount",
          '+      : 0;',
          '+    return money(Math.max(0, subtotal - discount) + shipping(cart));',
          '   }',
          ' ',
          '   export function shipping(cart: Cart): number {',
        ],
      },
    ];
    const items = [
      {
        kind: 'user',
        id: id('u'),
        text: 'The checkout total is wrong when a percentage coupon is applied — it treats 10% as €10. Can you find the bug, fix it, and add a test?',
        timestamp: t0,
      },
      { kind: 'thinking', id: id('th'), text: '**Looking for the coupon logic**\n\nThe user says percentage coupons are applied as flat amounts. I should find where `coupon.amount` is used in the cart total and check the coupon type definitions.' },
      { kind: 'text', id: id('t'), text: "I'll start by finding where coupons are applied to the cart total." },
      {
        kind: 'tool', id: 'toolu_grep1', name: 'Grep', status: 'done',
        input: { pattern: 'coupon\\.amount', path: 'src', output_mode: 'content', '-n': true },
        result: { isError: false, text: 'src/cart/total.ts:40:    const discount = coupon ? coupon.amount : 0;\nsrc/cart/summary.tsx:88:  {coupon && <Row label="Discount" value={-coupon.amount} />}\nsrc/api/orders.ts:132:    discount: coupon?.amount ?? 0,' },
      },
      {
        kind: 'tool', id: 'toolu_read1', name: 'Read', status: 'done',
        input: { file_path: CWD + '/src/cart/total.ts', offset: 30, limit: 40 },
        result: { isError: false, text: '    30→import { money, round2, sum } from "../lib/money";\n    31→import type { Cart, Coupon } from "./types";\n    32→\n    33→/**\n    34→ * Total due at checkout.\n    35→ */\n    36→\n    37→\n    38→export function cartTotal(cart: Cart, coupon?: Coupon): Money {\n    39→  const subtotal = sum(cart.items.map((i) => i.price * i.quantity));\n    40→  const discount = coupon ? coupon.amount : 0;' },
        structured: { type: 'text', file: { filePath: CWD + '/src/cart/total.ts', numLines: 40, startLine: 30, totalLines: 92 } },
      },
      {
        kind: 'tool', id: 'toolu_glob1', name: 'Glob', status: 'done',
        input: { pattern: 'src/**/*coupon*.ts' },
        result: { isError: false, text: CWD + '/src/cart/coupon.ts\n' + CWD + '/src/cart/coupon.test.ts\n' + CWD + '/src/api/coupons.ts' },
      },
      {
        kind: 'text', id: id('t'),
        text:
          "Found it. In `src/cart/total.ts:40` the discount is always treated as a fixed amount:\n\n```ts\nconst discount = coupon ? coupon.amount : 0;\n```\n\nBut `Coupon` has two kinds (see `src/cart/types.ts`):\n\n| kind | `amount` means | example |\n|---|---|---|\n| `fixed` | euros off | `5` → €5 off |\n| `percent` | percent off the subtotal | `10` → 10% off |\n\nI'll fix `cartTotal` so that percentage coupons use the subtotal, and make sure the total can't go negative. See the [money helpers](src/lib/money.ts#L12) for `round2`.",
      },
      {
        kind: 'tool', id: 'toolu_edit1', name: 'Edit', status: 'done',
        input: { file_path: CWD + '/src/cart/total.ts', old_string: '  const discount = coupon ? coupon.amount : 0;\n  return money(subtotal - discount + shipping(cart));', new_string: "  // Percentage coupons apply to the subtotal only, never to shipping.\n  const discount = coupon\n    ? coupon.kind === 'percent' ? round2((subtotal * coupon.amount) / 100) : coupon.amount\n    : 0;\n  return money(Math.max(0, subtotal - discount) + shipping(cart));" },
        result: { isError: false, text: 'The file src/cart/total.ts has been updated successfully.' },
        structured: { filePath: CWD + '/src/cart/total.ts', structuredPatch: editPatch, userModified: false },
      },
      {
        kind: 'tool', id: 'toolu_write1', name: 'Write', status: 'done',
        input: {
          file_path: CWD + '/src/cart/total.test.ts',
          content:
            "import { describe, expect, it } from 'vitest';\nimport { cartTotal } from './total';\n\nconst cart = { items: [{ price: 40, quantity: 2 }], shippingMethod: 'standard' } as const;\n\ndescribe('cartTotal', () => {\n  it('applies fixed coupons as euros off', () => {\n    expect(cartTotal(cart, { kind: 'fixed', amount: 10 }).value).toBe(74.9);\n  });\n\n  it('applies percentage coupons to the subtotal', () => {\n    expect(cartTotal(cart, { kind: 'percent', amount: 10 }).value).toBe(76.9);\n  });\n\n  it('never goes below shipping', () => {\n    expect(cartTotal(cart, { kind: 'fixed', amount: 500 }).value).toBe(4.9);\n  });\n});\n",
        },
        result: { isError: false, text: 'File created successfully at: ' + CWD + '/src/cart/total.test.ts' },
        structured: { type: 'create', filePath: CWD + '/src/cart/total.test.ts', structuredPatch: [], originalFile: null },
      },
      {
        kind: 'tool', id: 'toolu_bash1', name: 'Bash', status: 'error',
        input: { command: 'npx vitest run src/cart --reporter=dot', description: 'Run the cart tests' },
        result: { isError: true, text: '\u001b[31m FAIL \u001b[39m src/cart/total.test.ts > cartTotal > applies percentage coupons to the subtotal\nAssertionError: expected 76.89999999999999 to be 76.9\n  ❯ src/cart/total.test.ts:12:58\n\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\nError: Exit code 1' },
      },
      { kind: 'text', id: id('t'), text: 'One floating-point issue — the shipping add needs rounding too. Fixing that:' },
      {
        kind: 'tool', id: 'toolu_multiedit1', name: 'MultiEdit', status: 'done',
        input: { file_path: CWD + '/src/cart/total.ts', edits: [{ old_string: '  return money(Math.max(0, subtotal - discount) + shipping(cart));', new_string: '  return money(round2(Math.max(0, subtotal - discount) + shipping(cart)));' }, { old_string: "import { money, round2, sum } from \"../lib/money\";", new_string: "import { money, round2, sum } from '../lib/money';" }] },
        result: { isError: false, text: 'Applied 2 edits to src/cart/total.ts' },
      },
      {
        kind: 'tool', id: 'toolu_bash2', name: 'Bash', status: 'done',
        input: { command: 'npx vitest run src/cart --reporter=dot', description: 'Run the cart tests again' },
        result: { isError: false, text: ' \u001b[32m✓\u001b[39m src/cart/total.test.ts (3 tests) 4ms\n \u001b[32m✓\u001b[39m src/cart/coupon.test.ts (7 tests) 6ms\n\n Test Files  2 passed (2)\n      Tests  10 passed (10)\n   Start at  14:02:11\n   Duration  412ms' },
        structured: { stdout: '...', stderr: '', interrupted: false },
      },
      {
        kind: 'tool', id: 'toolu_todo1', name: 'TodoWrite', status: 'done',
        input: { todos: [
          { content: 'Find where coupons change the cart total', status: 'completed', activeForm: 'Finding where coupons change the cart total' },
          { content: 'Fix percentage coupons in cartTotal', status: 'completed', activeForm: 'Fixing percentage coupons' },
          { content: 'Add tests for fixed and percentage coupons', status: 'completed', activeForm: 'Adding tests' },
          { content: 'Check the order summary and API use the same logic', status: 'in_progress', activeForm: 'Checking the order summary and API' },
          { content: 'Update the changelog', status: 'pending', activeForm: 'Updating the changelog' },
        ] },
        result: { isError: false, text: 'Todos have been modified successfully.' },
      },
      { kind: 'turn-end', id: id('end'), durationMs: 72000, isError: false },

      { kind: 'user', id: id('u'), text: 'Great. Can you check whether the order summary and the API have the same bug? Use an agent so you don’t fill up the context.', timestamp: t0 + 4 * 60000 },
      {
        kind: 'tool', id: 'toolu_task1', name: 'Task', status: 'done',
        input: { description: 'Audit coupon math in summary and API', subagent_type: 'Explore', prompt: 'Look at src/cart/summary.tsx and src/api/orders.ts. Report every place that uses coupon.amount directly and whether percentage coupons are handled. Be concise.' },
        result: { isError: false, text: "Both places use `coupon.amount` directly:\n\n1. **`src/cart/summary.tsx:88`** shows `-coupon.amount` as the discount row, so a 10% coupon shows as **−€10.00**.\n2. **`src/api/orders.ts:132`** stores `discount: coupon?.amount ?? 0`, so orders get the wrong discount saved.\n\nRecommendation: export a `couponDiscount(subtotal, coupon)` helper from `src/cart/total.ts` and use it in both places." },
      },
      { kind: 'tool', id: 'toolu_sub1', name: 'Read', status: 'done', parentToolUseId: 'toolu_task1', input: { file_path: CWD + '/src/cart/summary.tsx' }, result: { isError: false, text: '...' } },
      { kind: 'tool', id: 'toolu_sub2', name: 'Grep', status: 'done', parentToolUseId: 'toolu_task1', input: { pattern: 'discount', path: 'src/api' }, result: { isError: false, text: 'src/api/orders.ts:132:    discount: coupon?.amount ?? 0,' } },
      { kind: 'text', id: id('t'), parentToolUseId: 'toolu_task1', text: 'Both the summary row and the API read `coupon.amount` directly.' },
      { kind: 'tool', id: 'toolu_sub3', name: 'Read', status: 'done', parentToolUseId: 'toolu_task1', input: { file_path: CWD + '/src/api/orders.ts', offset: 120, limit: 30 }, result: { isError: false, text: '...' } },
      {
        kind: 'tool', id: 'toolu_ask1', name: 'AskUserQuestion', status: 'done',
        input: { questions: [{ question: 'Should the API recompute old orders with the fixed discount?', header: 'Old orders', multiSelect: false, options: [{ label: 'Only new orders', description: 'Leave existing orders as they are.' }, { label: 'Backfill', description: 'Recompute discounts for past orders with a migration.' }] }] },
        result: { isError: false, text: 'Your questions have been answered: "Should the API recompute old orders with the fixed discount?"="Only new orders". You can now continue with these answers in mind.' },
        structured: { answers: { 'Should the API recompute old orders with the fixed discount?': 'Only new orders' } },
      },
      { kind: 'system', id: id('s'), level: 'info', tag: 'mode', text: 'Switched to Plan mode' },
      {
        kind: 'tool', id: 'toolu_plan1', name: 'ExitPlanMode', status: 'done',
        input: { plan: '## Plan: one discount helper\n\n1. Add `couponDiscount(subtotal, coupon)` to `src/cart/total.ts` and use it inside `cartTotal`.\n2. Use it in `src/cart/summary.tsx` for the discount row.\n3. Use it in `src/api/orders.ts` when creating orders (new orders only).\n4. Extend `total.test.ts` with helper tests.\n\nNo database migration.', planFilePath: '/Users/alex/.claude/plans/one-discount-helper.md' },
        result: { isError: false, text: 'User has approved your plan.' },
      },
      { kind: 'system', id: id('s'), level: 'info', tag: 'mode', text: 'Switched to Edit automatically' },
      {
        kind: 'tool', id: 'toolu_web1', name: 'WebSearch', status: 'done',
        input: { query: 'rounding money in JavaScript banker\'s rounding' },
        result: { isError: false, text: 'Web search results for "rounding money in JavaScript":\n\n- **MDN — Number.prototype.toFixed()**: toFixed uses round-half-up on the binary value…\n- **Stack Overflow — How to round to at most 2 decimal places**: use `Math.round((n + Number.EPSILON) * 100) / 100`.' },
      },
      {
        kind: 'tool', id: 'toolu_fetch1', name: 'WebFetch', status: 'done',
        input: { url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/toFixed', prompt: 'How does toFixed round?' },
        result: { isError: false, text: '`toFixed()` rounds the **binary floating-point** value, so `1.005.toFixed(2)` returns `"1.00"`.' },
      },
      {
        kind: 'tool', id: 'toolu_mcp1', name: 'mcp__playwright__browser_take_screenshot', status: 'done',
        input: { fullPage: false, type: 'png' },
        result: { isError: false, text: 'Took the viewport screenshot.', images: [{ mediaType: 'image/svg+xml', data: '', url: 'sample-screenshot.svg', name: 'checkout.png' }] },
      },
      {
        kind: 'tool', id: 'toolu_ts1', name: 'ToolSearch', status: 'done',
        input: { query: 'select:mcp__playwright__browser_navigate,mcp__playwright__browser_click', max_results: 5 },
        result: { isError: false, text: '' },
        structured: { matches: ['mcp__playwright__browser_navigate', 'mcp__playwright__browser_click'], query: 'select:…', total_deferred_tools: 201 },
      },
      { kind: 'tool', id: 'toolu_bash_denied', name: 'Bash', status: 'denied', input: { command: 'git push --force origin feature/checkout-coupons' }, result: { isError: true, text: "The user doesn't want to proceed with this tool use." } },
      { kind: 'system', id: id('s'), level: 'info', tag: 'interrupted', text: 'Interrupted · What should Claude do instead?' },
      { kind: 'system', id: id('s'), level: 'warning', tag: 'retry', text: 'API error (overloaded). Retrying in 4s… (attempt 2/10)' },
      { kind: 'user', id: id('u'), text: '/compact keep the plan and the test results', command: '/compact', timestamp: t0 + 12 * 60000 },
      { kind: 'system', id: id('s'), level: 'info', tag: 'compact', text: 'Conversation compacted' },
      { kind: 'user', id: id('u'), text: 'Here is how the summary looks now — the discount row still says −€10.', images: [{ mediaType: 'image/png', data: TINY_PNG, name: 'paste.png' }, { mediaType: 'image/svg+xml', data: '', url: 'sample-screenshot.svg', name: 'summary.png' }], timestamp: t0 + 14 * 60000 },
      { kind: 'text', id: id('t'), text: "That screenshot is from before the change — the summary still reads `coupon.amount`. I'll switch it to the helper." },
      { kind: 'tool', id: 'toolu_generic1', name: 'NotebookEdit', status: 'done', input: { notebook_path: CWD + '/analysis/coupons.ipynb', cell_id: 'cell-3', new_source: "df['discount'] = df.apply(coupon_discount, axis=1)\ndf.groupby('kind')['discount'].mean()" }, result: { isError: false, text: 'Updated cell cell-3' } },
      { kind: 'tool', id: 'toolu_lsp1', name: 'mcp__ide__getDiagnostics', status: 'done', input: { uri: 'file://' + CWD + '/src/cart/summary.tsx' }, result: { isError: false, text: '[]' } },
      { kind: 'system', id: id('s'), level: 'info', tag: 'command-output', text: 'Total cost:            $0.42\nTotal duration (API):  1m 52s\nTotal code changes:    38 lines added, 6 lines removed' },
      { kind: 'system', id: id('s'), level: 'error', text: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' },
      { kind: 'turn-end', id: id('end'), durationMs: 3000, isError: true, errorText: 'Claude stopped: the API is overloaded. Try again in a moment.' },
    ];
    return items;
  }

  const fixtures = {
    conversation: () => ({ state: base({ items: conversation() }) }),

    empty: () => ({ state: base({ status: 'new', sessionId: undefined, title: 'New session', items: [], contextUsage: undefined, modelLabel: 'Opus 5.5' }) }),

    running: () => {
      const items = conversation().slice(0, 9);
      items.push({ kind: 'user', id: 'u-run', text: 'Run the full test suite and fix anything that breaks.', timestamp: now - 20000 });
      items.push({ kind: 'thinking', id: 'th-run', text: '', streaming: true });
      return {
        state: base({ items, status: 'running', activity: undefined, turnStartedAt: now - 14000, contextUsage: { usedTokens: 152000, maxTokens: 200000, percent: 76 } }),
        script: [
          [600, { type: 'items', items: [{ kind: 'thinking', id: 'th-run', text: 'Planning the test run', streaming: false }] }],
          [900, { type: 'items', items: [{ kind: 'tool', id: 'toolu_run1', name: 'Bash', status: 'streaming', input: {}, partialInput: '' }] }],
          [1000, { type: 'delta', id: 'toolu_run1', field: 'partialInput', text: '{"command":"npm run te' }],
          [1150, { type: 'delta', id: 'toolu_run1', field: 'partialInput', text: 'st -- --coverage","description":"Run all tests"}' }],
          [1300, { type: 'items', items: [{ kind: 'tool', id: 'toolu_run1', name: 'Bash', status: 'running', input: { command: 'npm run test -- --coverage', description: 'Run all tests' }, startedAt: Date.now() - 4000 }] }],
          [1300, { type: 'patch', patch: { activity: 'Running Bash' } }],
          [2600, { type: 'items', items: [{ kind: 'tool', id: 'toolu_run1', name: 'Bash', status: 'done', input: { command: 'npm run test -- --coverage', description: 'Run all tests' }, result: { isError: false, text: 'Test Files  14 passed (14)\n     Tests  128 passed (128)' } }] }],
          [2700, { type: 'patch', patch: { activity: null } }],
          [2700, { type: 'items', items: [{ kind: 'text', id: 't-stream', text: '', streaming: true }] }],
          ...'All **128 tests pass**, including the new coupon tests. Coverage for `src/cart` is now 96%.\n\nHere is a summary of what changed:\n\n- `cartTotal` handles percentage coupons\n- the order summary uses the same helper\n- new tests in `src/cart/total.test.ts`\n\n```ts\nexport function couponDiscount(subtotal: number, coupon?: Coupon): number {\n  if (!coupon) return 0;\n  return coupon.kind === \'percent\' ? round2((subtotal * coupon.amount) / 100) : coupon.amount;\n}\n```'
            .match(/[\s\S]{1,7}/g)
            .map((chunk, i) => [2800 + i * 30, { type: 'delta', id: 't-stream', field: 'text', text: chunk }]),
        ],
      };
    },

    todos: () => {
      const items = conversation().slice(0, 6);
      return {
        state: base({
          items,
          status: 'running',
          activity: 'Editing src/cart/total.ts',
          turnStartedAt: now - 95000,
          todos: [
            { content: 'Find where coupons change the cart total', status: 'completed' },
            { content: 'Fix percentage coupons in cartTotal', status: 'in_progress', activeForm: 'Fixing percentage coupons in cartTotal' },
            { content: 'Add tests for fixed and percentage coupons', status: 'pending' },
            { content: 'Update the changelog', status: 'pending' },
          ],
        }),
      };
    },

    bookmarks: () => {
      const items = conversation();
      const user = items.find((i) => i.kind === 'user');
      const tool = items.find((i) => i.kind === 'tool' && i.name === 'Edit') || items.find((i) => i.kind === 'tool');
      return {
        state: base({
          items,
          bookmarks: [
            { itemId: user.id, kind: 'user', label: user.text.split('\n')[0].slice(0, 80), createdAt: now - 600000 },
            { itemId: tool.id, kind: 'tool', label: 'Editing src/cart/summary.tsx', createdAt: now - 300000 },
          ],
        }),
      };
    },

    elicitation: () => ({
      state: base({
        items: conversation().slice(0, 6),
        status: 'waiting',
        pending: [
          {
            kind: 'elicitation', requestId: 'req-elicit', serverName: 'deploy', title: 'Deploy service', message: 'Where should I deploy the checkout fix?', mode: 'form', createdAt: now - 3000,
            fields: [
              { name: 'env', label: 'Environment', type: 'enum', required: true, options: [{ value: 'staging', label: 'Staging' }, { value: 'production', label: 'Production' }] },
              { name: 'replicas', label: 'Replicas', type: 'integer', required: true, minimum: 1, maximum: 5 },
              { name: 'region', label: 'Region', type: 'enum', required: false, options: ['eu-west-1', 'eu-central-1', 'us-east-1', 'us-east-2', 'us-west-2', 'ap-south-1', 'ap-northeast-1'].map((r) => ({ value: r, label: r })) },
              { name: 'notify', label: 'Notify the team', type: 'boolean', required: false, default: true },
              { name: 'email', label: 'Email', type: 'string', format: 'email', required: false, description: 'Who gets the deploy summary' },
            ],
          },
        ],
      }),
    }),

    'elicitation-url': () => ({
      state: base({
        items: conversation().slice(0, 6),
        status: 'waiting',
        pending: [{ kind: 'elicitation', requestId: 'req-url', serverName: 'github', message: 'Sign in to GitHub so I can open the pull request.', mode: 'url', url: 'https://github.com/login/device?code=ABCD-1234', fields: [], createdAt: now - 2000 }],
      }),
    }),

    'permission-bash': () => ({
      state: base({
        items: [...conversation().slice(0, 9), { kind: 'tool', id: 'toolu_perm_bash', name: 'Bash', status: 'waiting-permission', input: { command: 'npm install --save-dev @vitest/coverage-v8 && npx vitest run --coverage', description: 'Install the coverage plugin and run tests with coverage' } }],
        status: 'waiting',
        pending: [
          {
            kind: 'permission', requestId: 'req-bash', toolUseId: 'toolu_perm_bash', toolName: 'Bash', displayName: 'Bash',
            description: 'Install the coverage plugin and run tests with coverage',
            input: { command: 'npm install --save-dev @vitest/coverage-v8 && npx vitest run --coverage', description: 'Install the coverage plugin and run tests with coverage' },
            options: [
              { id: 'allow', label: 'Yes', kind: 'allow' },
              { id: 'allow-always', label: "Yes, and don't ask again for npm install commands in FeBundi", kind: 'allow-always' },
            ],
            decisionReason: 'This command changes package.json and installs packages.',
            createdAt: now - 4000,
          },
        ],
      }),
    }),

    'permission-edit': () => ({
      state: base({
        items: [...conversation().slice(0, 7), { kind: 'tool', id: 'toolu_perm_edit', name: 'Edit', status: 'waiting-permission', input: { file_path: CWD + '/src/cart/summary.tsx', old_string: '  {coupon && <Row label="Discount" value={-coupon.amount} />}', new_string: '  {coupon && (\n    <Row label="Discount" value={-couponDiscount(subtotal, coupon)} />\n  )}' } }],
        status: 'waiting',
        pending: [
          {
            kind: 'permission', requestId: 'req-edit', toolUseId: 'toolu_perm_edit', toolName: 'Edit',
            input: { file_path: CWD + '/src/cart/summary.tsx', old_string: '  {coupon && <Row label="Discount" value={-coupon.amount} />}', new_string: '  {coupon && (\n    <Row label="Discount" value={-couponDiscount(subtotal, coupon)} />\n  )}' },
            options: [
              { id: 'allow', label: 'Yes', kind: 'allow' },
              { id: 'allow-always', label: 'Yes, allow all edits during this session', kind: 'allow-always' },
            ],
            createdAt: now - 2000,
          },
          {
            kind: 'permission', requestId: 'req-edit-2', toolName: 'Write',
            input: { file_path: CWD + '/CHANGELOG.md', content: '## Unreleased\n\n- Fix percentage coupons at checkout\n' },
            options: [{ id: 'allow', label: 'Yes', kind: 'allow' }],
            createdAt: now - 1000,
          },
        ],
      }),
    }),

    'permission-mcp': () => ({
      state: base({
        items: conversation().slice(0, 4),
        status: 'waiting',
        pending: [
          {
            kind: 'permission', requestId: 'req-mcp', toolName: 'mcp__playwright__browser_navigate', displayName: 'browser_navigate',
            input: { url: 'http://localhost:5173/checkout?coupon=TEN' },
            options: [{ id: 'allow', label: 'Yes', kind: 'allow' }, { id: 'allow-always', label: "Yes, and don't ask again for playwright › browser_navigate", kind: 'allow-always' }],
            defaultToNo: true,
            createdAt: now - 1000,
          },
        ],
      }),
    }),

    question: () => ({
      state: base({
        items: conversation().slice(0, 5),
        status: 'waiting',
        pending: [
          {
            kind: 'question', requestId: 'req-q', toolUseId: 'toolu_q',
            questions: [
              { question: 'Which places should use the new discount helper?', header: 'Scope', multiSelect: true, options: [{ label: 'Cart total', description: 'cartTotal in src/cart/total.ts' }, { label: 'Order summary', description: 'The discount row in the checkout summary' }, { label: 'Orders API', description: 'The discount saved with each new order' }] },
              { question: 'How should discounts be rounded?', header: 'Rounding', multiSelect: false, options: [{ label: 'Half up', description: 'Standard commercial rounding (2.345 → 2.35)', preview: 'round2(2.345) === 2.35\nround2(2.344) === 2.34' }, { label: 'Banker’s', description: 'Round half to even (2.345 → 2.34)', preview: 'roundHalfEven(2.345) === 2.34\nroundHalfEven(2.355) === 2.36' }] },
            ],
            createdAt: now - 3000,
          },
        ],
      }),
    }),

    'question-single': () => ({
      state: base({
        items: conversation().slice(0, 3),
        status: 'waiting',
        pending: [
          { kind: 'question', requestId: 'req-q1', questions: [{ question: 'Which color do you prefer for the coupon badge?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'Matches the sale banner' }, { label: 'Blue', description: 'Matches the brand color' }] }], createdAt: now },
        ],
      }),
    }),

    plan: () => ({
      state: base({
        items: conversation().slice(0, 9),
        status: 'waiting',
        permissionMode: 'plan',
        pending: [
          {
            kind: 'plan', requestId: 'req-plan', toolUseId: 'toolu_plan2', planFilePath: '/Users/alex/.claude/plans/one-discount-helper.md',
            plan: '## One discount helper for the whole checkout\n\n**Why:** three places compute the coupon discount differently.\n\n1. Add `couponDiscount(subtotal, coupon)` to `src/cart/total.ts`\n   - fixed coupons: euros off\n   - percent coupons: percentage of the subtotal, rounded to cents\n2. Use it in `cartTotal`, `src/cart/summary.tsx` and `src/api/orders.ts`\n3. Tests: extend `src/cart/total.test.ts` (fixed, percent, over-discount)\n\n```ts\nexport function couponDiscount(subtotal: number, coupon?: Coupon): number\n```\n\nOut of scope: recomputing old orders.',
            createdAt: now - 2000,
          },
        ],
      }),
    }),

    error: () => ({ state: base({ items: conversation().slice(0, 6), status: 'error', error: 'Claude Code exited unexpectedly (code 1): Error: Credit balance is too low' }) }),

    live: () => ({ state: base({ items: conversation().slice(0, 8), liveElsewhere: { source: 'VS Code', pid: 80434, status: 'busy' } }) }),

    truncated: () => ({ state: base({ items: conversation().slice(6), historyTruncated: true }) }),

    worktree: () => ({ state: base({ items: conversation().slice(0, 3), isWorktree: true, branch: 'claude/coupon-helper', projectName: 'FeBundi', title: 'Coupon helper (worktree)', permissionMode: 'acceptEdits' }) }),

    long: () => {
      const items = [];
      for (let i = 0; i < 160; i++) {
        items.push({ kind: 'user', id: `lu${i}`, text: `Step ${i + 1}: refactor module ${i} and keep the tests green.` });
        items.push({ kind: 'text', id: `lt${i}`, text: `Working on **module ${i}**. I'll read it first, then apply the change.\n\n- keeps the public API\n- adds \`module${i}.test.ts\`` });
        items.push({ kind: 'tool', id: `lr${i}`, name: 'Read', status: 'done', input: { file_path: `${CWD}/src/modules/module${i}.ts` }, result: { isError: false, text: 'export const x = 1;' } });
        items.push({ kind: 'tool', id: `le${i}`, name: 'Edit', status: 'done', input: { file_path: `${CWD}/src/modules/module${i}.ts`, old_string: `export const x = ${i};`, new_string: `export const x = ${i + 1};\nexport const y = ${i};` } });
      }
      return { state: base({ items, title: 'Long session (640 items)' }) };
    },
  };

  window.HARNESS_FIXTURES = fixtures;
})();
