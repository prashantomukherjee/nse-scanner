# NSE Options Scanner

## A Beginner's Guide to the Code

> *Personal Reference Notes*
>
> *by Prashanto Mukherjee*
>
> *Built with Claude · April 2026*

---

## Table of Contents

This guide is structured as a complete journey from zero to understanding every piece of your scanner. Read it in order if you're starting fresh, or jump to a section you need to revisit.

1. [Lesson 1 — The Big Picture: how the web works](#lesson-1--the-big-picture)
2. [Lesson 2 — Tour of your project: every file explained](#lesson-2--tour-of-your-project)
3. [Lesson 3 — Reading page.jsx: the scanner brain](#lesson-3--reading-pagejsx)
4. [Lesson 4 — JavaScript essentials: the language basics](#lesson-4--javascript-essentials)
5. [Lesson 5 — React state: how the screen updates automatically](#lesson-5--react-state)
6. [Lesson 6 — useEffect: running code at the right time](#lesson-6--useeffect)
7. [Lesson 7 — Async/await: handling slow operations](#lesson-7--asyncawait)
8. [Lesson 8 — JSX: HTML inside JavaScript](#lesson-8--jsx)
9. [Lesson 9 — Components and props: building blocks](#lesson-9--components-and-props)
10. [Lesson 10 — APIs and fetch: talking to the outside world](#lesson-10--apis-and-fetch)
11. [Lesson 11 — JSON: the data format](#lesson-11--json)
12. [Lesson 12 — CORS and the proxy pattern](#lesson-12--cors-and-the-proxy-pattern)
13. [Lesson 13 — Node.js, Next.js, and 'outside the browser'](#lesson-13--nodejs-nextjs-and-outside-the-browser)
14. [Lesson 14 — Vercel and deployment](#lesson-14--vercel-and-deployment)
15. [Lesson 15 — Git and GitHub: version control](#lesson-15--git-and-github)
16. [Lesson 16 — Modifying your scanner: where to edit what](#lesson-16--modifying-your-scanner)
17. [Appendix A — Glossary](#appendix-a--glossary)
18. [Appendix B — Common errors](#appendix-b--common-errors)
19. [Appendix C — Useful commands](#appendix-c--useful-commands)

---

## Lesson 1 — The Big Picture

### How a website actually works

Before we touch any code, you need a clear mental model of what's happening when you open a website. This will save you from confusion later.

When you visit any website (Google, your scanner, anything), three things are involved:

- **Your browser** — the program you use to view pages (Chrome, Firefox, Edge). It displays things and handles clicks.
- **A server** — a computer somewhere on the internet (or your laptop while testing) that sends pages and data to the browser when asked.
- **APIs** — other servers that have data we need (like Upstox for stock prices). The server can call these on the browser's behalf.

For your scanner, the picture looks like this:

```
Your Browser  <-->  Your Next.js Server  <-->  Upstox API
```

When you click "scan now," your **browser** asks your **server** for prices. The server asks **Upstox**. Upstox replies. Server passes data back to browser. Browser displays cards.

### The three languages of the web

Every website on Earth uses these three things working together:

**HTML — the skeleton**

HTML defines the structure of a page using "tags." An `<h1>` is a big heading. A `<button>` is a button. A `<table>` is a table. HTML answers: *What's on this page?*

**CSS — the skin and clothes**

CSS controls how things look — colors, sizes, fonts, spacing, borders. Same HTML can look totally different with different CSS. CSS answers: *How does it look?*

**JavaScript — the brain and muscles**

JavaScript controls behavior — what happens when you click, what data fills the table, when something fades in. JavaScript answers: *What happens when something changes?*

> 💡 **In your scanner**, all three are mixed together inside `page.jsx` using a syntax called JSX. That's modern React's superpower — you write everything in one file.

### What is React?

React is a JavaScript library that makes building interactive UIs easier.

Without React, every time data changed (e.g., new gainers loaded), you'd have to manually find each piece of HTML and update it. That gets messy fast.

With React, you describe the UI based on data. When data changes, React automatically figures out what to update. The mental model is:

```
UI = function(state)
```

"Given this state, this is what the page should look like." That's it.

### What is Next.js?

Next.js is a framework built on top of React. Where React handles UI, Next.js adds:

- **Routing by folder** — make a folder called `login`, put a `page.jsx` in it, and `/login` automatically works as a URL.
- **API routes** — server-side code that runs on your computer (or Vercel). This is how `/api/upstox` and `/api/auth` work.
- **Middleware** — code that runs before every request (your password check).
- **Production optimization** — automatic code bundling, image compression, caching.

Think of it as: **React = UI library**, **Next.js = full app framework using React**.

### The flow when you click 'scan now'

Let's trace one user action through every layer. This single example explains the whole architecture:

1. You click "scan now" button in browser
2. `page.jsx` runs the `scan()` function
3. `scan()` calls `fetch('/api/upstox?url=...api.upstox.com/v2/quotes...')`
4. `middleware.js` intercepts: "Is this user logged in?" Yes (cookie present) → allow
5. `/api/upstox/route.js` receives the request
6. It re-sends the request to `api.upstox.com` with your token
7. Upstox returns ~213 stock prices as JSON
8. `/api/upstox` sends that JSON back to `page.jsx`
9. `page.jsx` processes: sorts by % change, picks top 20
10. React re-renders the cards with the new data
11. You see the gainers/losers list update on screen

### Lesson 1 checkpoint

You should now know:

- **HTML, CSS, JS** — structure, looks, behavior
- **React** — describe UI based on data; React updates the page automatically
- **Next.js** — adds server-side features (API routes, middleware) on top of React
- **The 3-layer flow** — Browser ↔ your server ↔ Upstox

---

## Lesson 2 — Tour of your project

### The folder structure

Open your project folder. Here's what each file/folder does:

```
nse-scanner-vercel/
│
├── package.json              "Recipe" listing libraries the project needs
├── next.config.js            Next.js settings (we use defaults)
├── jsconfig.json             VS Code helper for imports
├── .gitignore                Files Git should skip (node_modules, secrets)
├── .env.local                YOUR SECRETS (password). Never share!
├── .env.local.example        Template showing what .env.local should contain
├── README.md                 Documentation for humans
│
├── middleware.js             Password-protection guard
│
└── app/                      Everything user-facing lives here
    │
    ├── globals.css           Site-wide CSS (colors, fonts, spacing)
    ├── layout.jsx            "Frame" wrapping every page
    ├── page.jsx              MAIN SCANNER PAGE (most logic)
    │
    ├── login/
    │   └── page.jsx          Login page at /login
    │
    └── api/                  Server-side code (Node.js, not browser)
        ├── auth/route.js     Login: check password, set cookie
        ├── universe/route.js Fetch the 213 NSE F&O stocks
        └── upstox/route.js   Proxy that calls api.upstox.com
```

### Two big buckets

**Browser code (frontend)** — runs inside your Chrome tab:

- `app/page.jsx`
- `app/login/page.jsx`
- `app/layout.jsx`
- `app/globals.css`

**Server code (backend)** — runs invisibly on your computer (or Vercel):

- `middleware.js`
- `app/api/auth/route.js`
- `app/api/universe/route.js`
- `app/api/upstox/route.js`

> 💡 **Why split?** Browsers are sandboxed for security. They can't read files, hide secrets, or call APIs that block them (CORS). Server code can. So sensitive things go server-side.

### What each server file does

**`middleware.js` — the bouncer**

Runs BEFORE every request in your app. Checks: "Does this user have a valid session cookie?" If not, redirects to `/login`. Lets API auth requests through (otherwise no one could ever log in).

**`app/api/auth/route.js` — login handler**

Two things: (1) `POST` = check the password against `APP_PASSWORD` env var, set an HttpOnly cookie if correct, (2) `DELETE` = clear the cookie (logout).

**`app/api/universe/route.js` — stocks list builder**

Fetches the gzipped NSE instruments file from Upstox CDN, decompresses it, filters down to ~213 F&O stocks, and also builds a futures lookup map. Caches for 1 hour to avoid re-downloading.

**`app/api/upstox/route.js` — the proxy**

Takes any Upstox URL, forwards the request server-side (with your token), and returns the response back to the browser. Bypasses CORS restrictions. We covered this in detail in Lesson 12.

### How URL routes work in Next.js

Next.js uses a folder-based routing system. The URL maps directly to folder paths:

| URL                   | File that handles it        |
|-----------------------|-----------------------------|
| `/`                   | `app/page.jsx`              |
| `/login`              | `app/login/page.jsx`        |
| `/api/auth` (POST)    | `app/api/auth/route.js`     |
| `/api/upstox?url=...` | `app/api/upstox/route.js`   |
| `/api/universe`       | `app/api/universe/route.js` |

> ⚠️ **Case-sensitive!** We hit this bug — folder named `Universe` (capital U) didn't match `/api/universe`. Always use lowercase folder names for routes.

---

## Lesson 3 — Reading page.jsx

This file is the biggest (~1300 lines) but it's organized like a book. Let's read it section by section.

### Section 1: 'use client'

```jsx
"use client";
```

This single line at the top tells Next.js: "This file runs in the **BROWSER**, not on the server."

Why we need it: Next.js defaults to running files on the server (faster initial page load). But our scanner needs browser-only features — clicks, animations, real-time updates. So we explicitly mark it as a client component.

### Section 2: Imports

```jsx
import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
```

"Bring in tools I'll use from React and Next.js." Like grabbing tools from a toolbox before starting work.

- `useState` — store changeable data (gainers list, token, current tab)
- `useCallback` — performance helper that memoizes functions
- `useEffect` — run code at specific times (on page load, when state changes)
- `useRouter` — navigate between pages (e.g., redirect to `/login`)

### Section 3: Constants and config

```jsx
const UPSTOX = "https://api.upstox.com";
const PROXY  = "/api/upstox?url=";
const proxied = (target) => PROXY + encodeURIComponent(target);

const C = {
  text:    "var(--color-text-primary)",
  muted:   "var(--color-text-secondary)",
  // ...
};
```

Define shortcuts so you don't repeat yourself everywhere.

- `UPSTOX` — the Upstox API base URL
- `PROXY` — your own server-side proxy path
- `proxied(...)` — wraps any URL into the proxy URL with proper encoding
- `C` — color palette. Instead of typing the long CSS variable name, just write `C.text` or `C.gain`. The actual values come from `globals.css`.

### Section 4: Helper functions

Small utility functions used throughout:

- `fmtINR(v)` — formats a number with Indian commas (`1234567.89` → `"12,34,567.89"`)
- `fmtK(v)` — shortens big numbers (`123000` → `"123K"`)
- `moneyness(strike, spot)` — labels a strike as `"ITM"`, `"ATM"`, or `"OTM"`

These are pure helpers — same input always gives same output. No React, no API.

### Section 5: API call helpers

This is where we talk to Upstox. Three functions:

**`callUpstox(path, token)` — the foundation**

The basic "make a request to Upstox" function. Every other API call uses this. Handles authentication header, error checking, and JSON parsing.

**`fetchOhlc(keys, token)` — for stocks**

Calls `/v2/market-quote/quotes` — gives `net_change` for accurate broker-matching daily %.

**`fetchOptionOhlc(keys, token)` — for options**

Calls `/v3/market-quote/ohlc?interval=1d` — gives today's intraday open/high/low for option contracts.

> 💡 **Important architecture choice:** Stocks and options use DIFFERENT endpoints. `/quotes` gives previous-day-close for accurate daily change. `/ohlc` gives today's session OHLC for the open=low/high checks. Each endpoint serves a different need.

### Section 6: Expiry helpers

Compute "what's the expiry date for the current month / next month?"

- `lastTuesdayOfMonth(year, month)` — math to find the last Tuesday of any month (NSE stock options expiry day)
- `getMonthlyExpiries()` — builds the list shown in the dropdown (current and next month)
- `fetchExpiryForMonth(...)` — finds the actual Upstox expiry date for a stock in a given month
- `fetchChain(...)` — gets the full options chain for a stock at a given expiry
- `countSignalsForStock(...)` — used by the Ranked tab to count open=low/high signals across strikes

### Section 7: Components

Each component is a function that returns a piece of UI. The pattern:

```jsx
function ComponentName({ prop1, prop2 }) {
  // some logic here
  return (
    <div>...JSX markup...</div>
  );
}
```

Components in order:

| Component        | What it shows                                                 |
|------------------|---------------------------------------------------------------|
| `Skeleton`       | Loading bars (gray pulsing rectangles)                        |
| `TokenPanel`     | The 'paste your Upstox token' panel                           |
| `StockCard`      | One stock row in the gainers/losers list                      |
| `OptionsChain`   | The big options chain table on detail page                    |
| `DetailPage`     | The whole detail page (when you click a stock)                |
| `RankedCard`     | One row in the Ranked tab                                     |
| `RankedView`     | The whole Ranked tab content                                  |
| `ConvictionCard` | One row in the open=low/high tab                              |
| `ConvictionView` | The whole conviction tab content                              |
| `TabBar`         | The 4 tabs: ▲ gainers / ▼ losers / ◆ ranked / ◇ open=low/high |
| `ScannerPage`    | The MAIN function that ties everything together               |

### Section 8: ScannerPage — the main page

Long function (~700 lines) that:

1. Holds all the state (data that changes)
2. Defines the functions (`scan`, `loadUniverse`, `runRankedScan`, etc.)
3. Defines the effects (run on page load, run on tab change)
4. Returns the JSX to display everything

The `export default` at the end means: "This is the main thing this file provides — when Next.js loads `/`, render this."

---

## Lesson 4 — JavaScript essentials

Before going deeper, let's make sure you know the basics of JavaScript syntax. You don't need to memorize this — just have it as reference.

### Variables

Three ways to declare:

```js
const x = 5;     // Can't be reassigned (use this most of the time)
let y = 10;      // Can be reassigned
var z = 15;      // OLD — avoid in modern code
```

In your scanner, you'll see `const` everywhere because it's the modern standard.

### Data types

| Type      | Examples                                    |
|-----------|---------------------------------------------|
| Number    | `5`, `3.14`, `-100`                         |
| String    | `"hello"`, `'world'`, `` `template ${x}` `` |
| Boolean   | `true`, `false`                             |
| null      | intentionally empty                         |
| undefined | not set yet                                 |
| Array     | `[1, 2, 3]`                                 |
| Object    | `{name: "Prash", age: 40}`                  |

### Common operators

```js
// Math
+  -  *  /  %     (% is remainder/modulo)

// Comparison
===   strict equal (preferred)
!==   strict not equal
>  <  >=  <=

// Logical
&&    AND
||    OR (also "default value" when first is falsy)
!     NOT

// Coalescing
??    "use right side if left is null/undefined"
?.    "safely access property if object exists"
```

### Functions

Three syntaxes — all do the same thing:

```js
// Traditional
function add(a, b) {
  return a + b;
}

// Arrow function
const add = (a, b) => {
  return a + b;
};

// Arrow function (single expression — implicit return)
const add = (a, b) => a + b;
```

In React code, you'll see arrow functions everywhere because they're concise.

### Arrays — most important methods

```js
const nums = [1, 2, 3, 4, 5];

nums.length              // 5
nums[0]                  // 1 (first item)
nums[nums.length - 1]    // 5 (last item)

nums.map(n => n * 2)     // [2, 4, 6, 8, 10] — transform each
nums.filter(n => n > 2)  // [3, 4, 5] — keep matching ones
nums.find(n => n > 2)    // 3 — first match
nums.sort((a, b) => a - b)  // ascending
nums.slice(0, 3)         // [1, 2, 3] — first 3 items
nums.slice(-3)           // [3, 4, 5] — last 3 items
```

**Used everywhere in your scanner.** Top 20 gainers? `enriched.slice(0, 20)`. Filter by criteria? `.filter(...)`. Render each as a card? `.map(stock => <StockCard ... />)`.

### Objects

```js
const stock = { sym: "RELIANCE", ltp: 1267.30 };

stock.sym                    // "RELIANCE"
stock["sym"]                 // same thing

// Destructuring (used heavily in React)
const { sym, ltp } = stock;  // creates two variables in one line

// Spread
const updated = { ...stock, ltp: 1270 };  // copy + override

// Optional chaining (safe access)
stock?.sym                   // works even if stock is null
```

### Template literals

Strings with variables baked in, using backticks:

```js
const name = "Prash";
const greeting = `Hello, ${name}!`;     // "Hello, Prash!"

// Multi-line works too
const html = `
  <div>${name}</div>
`;
```

---

## Lesson 5 — React state

This is the most important concept in React. Once you get this, 80% of `page.jsx` makes sense.

### The core idea

Things on screen change all the time:

- Click 'scan now' → loading skeleton → then gainers list
- Click any gainer → list disappears → detail page appears
- Switch tab → different content shows

How does the page know to update? Through STATE.

> 💡 **Definition:** State = data that, when it changes, automatically re-renders the page.

### Meet useState

Simplest possible example:

```jsx
import { useState } from "react";

function Counter() {
  const [count, setCount] = useState(0);
  
  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>+1</button>
    </div>
  );
}
```

Decoded:

- `useState(0)` — "give me a piece of state, starting at 0"
- `[count, setCount]` — destructure two things: current value and the setter function
- `{count}` — insert the JavaScript value here in JSX
- `setCount(count + 1)` — when called, React notices state changed and re-renders the component

### Mental model

**OLD-school thinking** (jQuery, vanilla JS):

> *"When user clicks button, FIND the count element, GET its text, ADD 1, SET the new text."*
>
> *Imperative — you tell the browser exactly what to do step by step.*

**React thinking:**

> *"Here's how the screen looks based on state. State changed? Re-draw."*
>
> *Declarative — you describe the result, not the steps.*

### State in your scanner

Every line at the top of `ScannerPage` is a piece of state:

```jsx
const [token,    setToken]    = useState("");
const [universe, setUniverse] = useState(null);
const [gainers,  setGainers]  = useState(null);
const [losers,   setLosers]   = useState(null);
const [scanning, setScanning] = useState(false);
const [tab,      setTab]      = useState("gainers");
const [selected, setSelected] = useState(null);
// ... and many more
```

Reading the initial values tells you what each is for:

| Pattern               | Meaning                                         |
|-----------------------|-------------------------------------------------|
| `useState("")`        | Empty string. Used for typed text.              |
| `useState(true)`      | Starts true. Used for visibility flags.         |
| `useState(false)`     | Starts false. Used for 'is X happening?' flags. |
| `useState(null)`      | No data yet.                                    |
| `useState("gainers")` | Default tab.                                    |

### The flow when you click 'scan now'

1. **Initial state:** `gainers=null`, `scanning=false`. Screen: empty state.
2. **You click:** `setScanning(true)`. React re-renders. Screen: skeleton.
3. **API responds:** `setGainers([...])`, `setLosers([...])`, `setScanning(false)`. Screen: gainers list.
4. **You click a stock:** `setSelected({stock, list})`. Screen: detail page.
5. **You click back:** `setSelected(null)`. Screen: list again.

### Key rules

**Rule 1: Never mutate state directly**

```js
// ❌ WRONG — React won't notice
gainers.push(newStock);

// ✅ RIGHT — React notices
setGainers([...gainers, newStock]);
```

**Rule 2: State updates are asynchronous**

```js
// This won't work as expected
setCount(count + 1);
console.log(count); // Still the OLD count!
```

After calling the setter, the new value isn't immediately available. React schedules an update for the next render.

**Rule 3: Each useState is independent**

Call `useState` as many times as you want. Each is its own little container.

### Conditional rendering

Common pattern: show something only if state matches:

```jsx
{scanning && <Skeleton />}            // show only if scanning is true
{selected && <DetailPage ... />}      // show only if a stock is selected
{tab === "ranked" && <RankedView />}  // show only if tab is "ranked"
```

`{condition && <Component />}` reads as: "If this state is true, render that."

---

## Lesson 6 — useEffect

The second most important React concept. While `useState` handles 'what data,' `useEffect` handles 'when to do things.'

### The core idea

Some code shouldn't run during every render. Some code should only run:

- Once when the page loads (e.g., load the universe)
- When specific data changes (e.g., switching to ranked tab triggers a scan)
- When the page closes (e.g., clean up timers)

**`useEffect`** lets you say: "Run this code when X happens."

### Basic syntax

```jsx
useEffect(() => {
  // code that runs
}, [dependencies]);
```

- **First argument:** the function to run
- **Second argument:** an array of dependencies. The function runs when any of these change.

### Three patterns

**Pattern 1: Run once on mount**

```jsx
useEffect(() => {
  loadUniverse();
}, []);   // empty array = never re-run
```

In your scanner, this is how the universe gets loaded the moment the page opens.

**Pattern 2: Run when something changes**

```jsx
useEffect(() => {
  // Auto-trigger ranked scan when user switches to Ranked tab
  if (tab === "ranked" && gainers && losers && !rankedGainers) {
    runRankedScan();
  }
}, [tab, gainers, losers, rankedGainers]);
```

Runs whenever any item in the dependency array changes.

**Pattern 3: With cleanup**

```jsx
useEffect(() => {
  const id = setInterval(() => fetch(...), 60000);
  return () => clearInterval(id);   // cleanup runs when component unmounts
}, []);
```

Useful for timers, subscriptions, etc. The returned function runs when the component is removed from screen.

### In your scanner

Find these in `page.jsx` — they're all the useEffects you have:

1. `useEffect(() => { loadUniverse(); }, [loadUniverse])` — fetches stocks on first load
2. `useEffect(() => { loadChain(); }, [loadChain])` — loads option chain when detail page opens
3. `useEffect(() => { ... }, [tab, ...])` — auto-triggers ranked scan when you click that tab
4. `useEffect(() => { ... }, [tab, ...])` — auto-triggers conviction scan when you click that tab

---

## Lesson 7 — Async/await

Some code is fast (math). Some is slow (network calls). JavaScript needs special syntax for slow operations so the browser doesn't freeze while waiting.

### The problem

```js
// Imagine fetch() takes 2 seconds
const data = fetch("https://api.example.com/users");
console.log(data);   // What is this? It tried to print before fetch finished!
```

In synchronous code, the next line runs immediately. But network calls take time. We need to TELL JavaScript to wait.

### Promises (briefly)

Behind the scenes, slow operations return a "Promise" — an object that represents "I'll have the answer eventually."

You can attach `.then()` and `.catch()` to handle the eventual result:

```js
fetch(url)
  .then(response => response.json())
  .then(data => console.log(data))
  .catch(err => console.error(err));
```

This works but gets messy with multiple steps. Modern JavaScript prefers async/await.

### Async/await — the modern way

```js
async function loadData() {
  const response = await fetch(url);    // wait here until done
  const data = await response.json();   // wait here too
  console.log(data);
  return data;
}
```

Decoded:

- `async` — "this function does slow stuff"
- `await` — "pause here until this finishes, then continue with the result"

> ⚠️ **Important:** You can only use `await` inside an `async` function.

### In your scanner

Almost every API function uses this pattern:

```js
async function callUpstox(path, token) {
  const res = await fetch(proxied(UPSTOX + path), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json = await res.json();
  return json.data;
}
```

`try`/`catch` handles errors:

```js
try {
  const data = await callUpstox(...);
  setGainers(data);
} catch (e) {
  setScanErr(e.message);
}
```

If anything in the `try` block throws, control jumps to `catch`.

---

## Lesson 8 — JSX

JSX is the syntax that lets you write HTML-like code inside JavaScript. It's React's signature feature.

### The basics

```jsx
// Looks like HTML
const greeting = <h1>Hello!</h1>;

// But it's actually JavaScript
// React converts it into proper HTML behind the scenes
```

### Embed JavaScript with curly braces

```jsx
const name = "Prash";
const age = 40;
const greeting = <h1>Hello, {name}! You are {age} years old.</h1>;
//                            ^^^^         ^^^^
//                       JavaScript inside JSX
```

Anything inside `{ }` is JavaScript. You can use variables, math, function calls, anything that returns a value.

### Differences from HTML

| HTML way             | JSX way                       |
|----------------------|-------------------------------|
| `class="foo"`        | `className="foo"`             |
| `for="id"`           | `htmlFor="id"`                |
| `onclick="fn()"`     | `onClick={fn}`                |
| `style="color: red"` | `style={{color: "red"}}`      |
| `<input>`            | `<input />` (must self-close) |

**Why className?** Because `class` is a reserved keyword in JavaScript. React picked `className` to avoid conflicts.

### Conditional rendering

```jsx
// Show only if condition is true
{loading && <Spinner />}

// Show one or the other
{isLoggedIn ? <Dashboard /> : <LoginForm />}

// Multiple conditions
{loading ? <Spinner />
 : error  ? <ErrorMessage />
 : <Content />}
```

### Lists with .map()

```jsx
{stocks.map((stock, i) => (
  <StockCard key={stock.key} stock={stock} rank={i + 1} />
))}
```

**The `key` prop is critical** — React uses it to track which item is which. Use a unique value per item.

### Inline styles

```jsx
<div style={{ color: "red", fontSize: "16px", marginTop: "10px" }}>
  Hello
</div>
```

**Note:** two sets of curly braces. Outer `{ }` says "this is JavaScript". Inner `{ }` is the actual style object.

CSS property names use camelCase: `backgroundColor` not `background-color`, `fontSize` not `font-size`.

---

## Lesson 9 — Components and props

Components are reusable UI pieces. Props are the data you pass into them.

### Defining a component

```jsx
function StockCard({ stock, rank, isLoser, onClick }) {
  return (
    <div onClick={onClick}>
      <span>{rank}. {stock.sym}</span>
      <span>{stock.changePct}%</span>
    </div>
  );
}
```

A component is a function that returns JSX. Its argument is an object containing all the data passed in (called "props").

### Using a component

```jsx
<StockCard 
  stock={someStock} 
  rank={1} 
  isLoser={false}
  onClick={() => alert("clicked")}
/>
```

**Why this pattern?** You can render the same component many times with different data:

```jsx
{gainers.map((stock, i) => (
  <StockCard 
    key={stock.key}
    stock={stock} 
    rank={i + 1} 
    isLoser={false}
    onClick={() => setSelected({ stock, list: 'gainers' })}
  />
))}
```

This is how your gainers list shows 20 cards from the same component definition.

### Destructuring props

Two ways to write the same thing:

```jsx
// Option A: take props as one object
function StockCard(props) {
  return <div>{props.stock.sym}</div>;
}

// Option B: destructure on the way in (cleaner)
function StockCard({ stock }) {
  return <div>{stock.sym}</div>;
}
```

Option B is the modern preferred style. You'll see it everywhere in your scanner.

### Component composition

Big components contain smaller ones. In your scanner:

```
ScannerPage
  ├── TokenPanel
  ├── TabBar
  ├── StockCard (×20)
  ├── DetailPage
  │   └── OptionsChain
  ├── RankedView
  │   └── RankedCard (×N)
  └── ConvictionView
      └── ConvictionCard (×N)
```

---

## Lesson 10 — APIs and fetch

An API (Application Programming Interface) is just a website designed for code to talk to instead of humans. Instead of HTML pages, it returns data (usually JSON).

### How fetch works

```js
const response = await fetch("https://api.example.com/users");
const data = await response.json();
console.log(data);
```

1. `fetch(url)` sends a request to that URL
2. `response` is the result. Has metadata like status code (200, 404, etc.)
3. `response.json()` parses the body as JSON into a JavaScript object

### HTTP methods

Different verbs do different things:

| Method        | Purpose                      |
|---------------|------------------------------|
| `GET`         | Fetch data (most common)     |
| `POST`        | Create something / send data |
| `PUT`/`PATCH` | Update something             |
| `DELETE`      | Remove something             |

Default for `fetch` is GET. For others, pass options:

```js
await fetch("/api/auth", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: "secret" }),
});
```

### Headers

Extra metadata sent with the request. Common ones:

- `Content-Type` — what kind of data you're sending
- `Authorization` — your token or credentials
- `Accept` — what kind of data you want back

### In your scanner

This is the actual code that talks to Upstox:

```js
const res = await fetch(proxied(UPSTOX + path), {
  headers: { 
    "Accept": "application/json", 
    "Authorization": `Bearer ${token}` 
  },
});
if (!res.ok) {
  throw new Error(`HTTP ${res.status}`);
}
const json = await res.json();
```

---

## Lesson 11 — JSON

JSON (JavaScript Object Notation) is the universal data format on the web. It looks just like a JavaScript object but with stricter rules.

### What it looks like

```json
{
  "status": "success",
  "data": {
    "symbol": "RELIANCE",
    "last_price": 1267.30,
    "ohlc": {
      "open": 1283.5,
      "high": 1290.5,
      "low": 1264.6,
      "close": 1267.3
    }
  }
}
```

### Rules

- Keys must be in double quotes (no single quotes, no unquoted keys)
- Strings must be in double quotes
- Numbers, `true`, `false`, `null` are written plainly
- No trailing commas
- No comments

### Working with JSON

```js
// Parse JSON text into a JavaScript object
const data = JSON.parse(jsonText);

// Convert a JavaScript object back to JSON text
const jsonText = JSON.stringify(myObject);

// fetch().json() does the parse step automatically
const data = await response.json();
```

---

## Lesson 12 — CORS and the proxy pattern

CORS confuses everyone at first. Here's the full story.

### What's an 'origin'?

An origin = `protocol + domain + port`. Examples:

| Address                         | Origin                                                      |
|---------------------------------|-------------------------------------------------------------|
| `https://www.google.com/search` | `https://www.google.com`                                    |
| `https://www.google.com/maps`   | `https://www.google.com` (same)                             |
| `https://mail.google.com`       | `https://mail.google.com` (different!)                      |
| `http://localhost:3000`         | `http://localhost:3000`                                     |
| `http://localhost:5000`         | `http://localhost:5000` (different port = different origin) |

### Why browsers block cross-origin requests

Imagine a world without CORS rules:

1. You log into your bank — session cookie stored in browser
2. Later, you visit a sketchy site
3. Sketchy site secretly runs: `fetch("yourbank.com/transfer?to=hacker")`
4. Browser auto-attaches your cookies (it's the same domain)
5. Bank thinks YOU authorized the transfer. Money gone.

This was a real attack (CSRF). Browsers fixed it with CORS:

> ⚠️ **The CORS rule:** By default, code on one origin CANNOT make requests to a different origin. Period.

### How servers can opt-in

If a server WANTS to allow cross-origin requests, it adds a header:

```
Access-Control-Allow-Origin: http://localhost:3000
```

Browsers see this header and allow the request through. But many APIs (like Upstox) don't add this — they require server-to-server access for security.

### The key insight

> 💡 **Critical:** CORS is enforced by the **BROWSER**, not by the server. Server-to-server requests have NO CORS rules.

This is the loophole we exploit:

```
Browser → Your Server (same origin, OK)
Your Server → Upstox (server-to-server, no CORS rules apply)
```

### Your proxy in code

File: `app/api/upstox/route.js`

```js
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const target = searchParams.get("url");
  const auth = request.headers.get("authorization");

  const upstreamRes = await fetch(target, {
    headers: { 
      "Accept": "application/json", 
      "Authorization": auth 
    },
  });

  const text = await upstreamRes.text();
  return new Response(text, { status: upstreamRes.status });
}
```

Plain English: "Receive a request, extract the Upstox URL and token, forward to Upstox, return the response unchanged." That's it.

---

## Lesson 13 — Node.js, Next.js, and 'outside the browser'

### Where JavaScript runs

Originally, JavaScript only worked inside browsers. Browsers had "engines" that read JavaScript text and executed it:

- **V8** — built by Google, lives inside Chrome
- **SpiderMonkey** — Mozilla, lives inside Firefox
- **JavaScriptCore** — Apple, lives inside Safari

In 2009, someone took Google's V8 engine and packaged it as a standalone program you could run anywhere. That's **Node.js**.

### Browser JS vs Node.js

| Browser JS             | Node.js                      |
|------------------------|------------------------------|
| Sandboxed for security | Full access to your computer |
| Can't read files       | CAN read/write files         |
| Can't be a server      | CAN be a server              |
| Has DOM (`document`)   | No DOM                       |
| Has `window` object    | Has `process` object         |
| User clicks → JS runs  | You run it manually          |

### Your scanner uses BOTH

**Browser-side JavaScript:** `app/page.jsx`, `app/login/page.jsx` — runs in your Chrome tab.

**Server-side JavaScript:** `middleware.js`, `app/api/*/route.js` — runs in Node.js when triggered.

Both are JavaScript. Different homes, different abilities.

### What is Next.js then?

Next.js is a framework built on top of Node.js + React. It handles all the boring infrastructure:

- Routing (folder = URL)
- JSX compilation
- Hot reload during development
- Code bundling and optimization
- Serverless function deployment
- Cookie/header parsing for middleware

Without Next.js, you'd write hundreds of lines of plumbing before adding a single feature.

### The layer cake

```
┌────────────────────────────────────────┐
│  YOUR CODE (page.jsx, route.js, etc.)  │
├────────────────────────────────────────┤
│  NEXT.JS (routing, compilation, etc.)  │
├────────────────────────────────────────┤
│  REACT (UI components, state)          │
├────────────────────────────────────────┤
│  NODE.JS (runs the JavaScript)         │
└────────────────────────────────────────┘
```

---

## Lesson 14 — Vercel and deployment

### What is Vercel?

A hosting company. They run your app on their computers so the world can access it. Without hosting, your app only works while `npm run dev` is running on YOUR laptop.

### Why Vercel for Next.js

- Built by the Next.js team — best support possible
- Zero config — just connect GitHub, click deploy
- Free Hobby tier with real, usable limits
- Automatic HTTPS
- Global CDN — fast everywhere
- Auto-deploys when you push to GitHub

### Serverless functions

Traditional servers run 24/7 waiting for requests. Costs money even when idle.

Serverless functions only run WHEN CALLED:

1. Request comes in (e.g., `/api/upstox?...`)
2. Vercel spins up a Node.js process in milliseconds
3. Your code runs
4. Response sent
5. Process shuts down

This is why Vercel can offer such generous free tiers. You only consume resources during actual API calls.

### Environment variables

Secrets like `APP_PASSWORD` shouldn't be in your code (or your GitHub repo). Vercel stores them encrypted, only visible to your serverless functions.

To set one: Vercel project → Settings → Environment Variables → Add.

In code, you read it via `process.env.APP_PASSWORD`.

### The deploy flow

```
Code locally → npm run dev (test) → git push → Vercel auto-builds → Live
```

---

## Lesson 15 — Git and GitHub

### What's Git

Git tracks every change you make to your code. Like "undo" but powerful — you can:

- See exactly what changed and when
- Revert any change
- Have multiple parallel versions (branches)
- Collaborate without overwriting each other

### What's GitHub

GitHub is a website that hosts Git repositories online. Like Google Drive, but for code, with built-in collaboration tools.

### Daily workflow

```bash
# 1. Edit your code in VS Code
# 2. Stage all changes
git add .

# 3. Save a snapshot with a message
git commit -m "added watchlist feature"

# 4. Send to GitHub (which triggers Vercel)
git push
```

### Useful commands

| Command                 | Purpose                           |
|-------------------------|-----------------------------------|
| `git status`            | What's changed since last commit? |
| `git diff`              | Show me the actual changes        |
| `git log`               | History of commits                |
| `git checkout .`        | Discard ALL uncommitted changes   |
| `git reset --hard HEAD` | Same as above, more nuclear       |
| `git remote -v`         | Show connected GitHub URLs        |
| `git branch`            | List branches                     |
| `git pull`              | Get latest from GitHub            |

---

## Lesson 16 — Modifying your scanner

Now that you know the parts, here's how to figure out where to make changes.

### Decision tree

"I want to change ___":

| Change                  | File                                             |
|-------------------------|--------------------------------------------------|
| Colors / styling        | `app/globals.css` OR inline styles in `page.jsx` |
| Top bar / navigation    | ScannerPage's return JSX (top of return)         |
| Stock card layout       | `StockCard` component                            |
| Detail page             | `DetailPage` component                           |
| Options chain table     | `OptionsChain` component                         |
| What stocks are scanned | `scan()` function                                |
| How rankings work       | `runRankedScan()` function                       |
| Conviction logic        | `runConvictionScan()` function                   |
| Login page              | `app/login/page.jsx`                             |
| Password check          | `app/api/auth/route.js`                          |
| What endpoints we hit   | `callUpstox` / `fetchOhlc` / `fetchOptionOhlc`   |
| Universe filtering      | `app/api/universe/route.js`                      |

### Common feature patterns

**Adding a new tab**

1. Add new state: `const [myTab, setMyTab] = useState(...)`
2. Add tab to `TabBar` component
3. Build a new View component
4. Add `{tab === "newtab" && <MyView />}` in render

**Adding a new filter to gainers**

1. Add state: `const [minPct, setMinPct] = useState(0)`
2. Add input in render: `<input value={minPct} onChange={...} />`
3. Filter `activeList`: `gainers.filter(s => s.changePct >= minPct).map(...)`

**Adding auto-refresh**

1. `useEffect` with `setInterval`
2. Inside it: call `scan()` every N seconds
3. Return cleanup: `return () => clearInterval(id)`

### Best practices when editing

- Make small changes, save, refresh, see if it works. Don't change 5 things at once.
- If something breaks, undo with Ctrl+Z and try smaller steps.
- Use `console.log()` liberally to debug.
- Commit often. `git commit -m "working state"` gives you a save point.
- Hard refresh (Ctrl+Shift+R) when something seems cached.
- If brace mismatch errors → use VS Code's bracket matching (click a brace, see its pair).

---

## Appendix A — Glossary

Quick reference for every term used in this guide.

| Term              | Definition                                                                                         |
|-------------------|----------------------------------------------------------------------------------------------------|
| API               | Application Programming Interface. A URL designed for code to call (returns data, not HTML).       |
| async / await     | Syntax for writing code that handles slow operations like network calls.                           |
| Babel             | Tool that converts JSX into plain JavaScript. Used internally by Next.js.                          |
| browser           | The program you view websites with (Chrome, Edge, Firefox).                                        |
| build             | The process of converting your dev code into optimized production code.                            |
| callback          | A function passed to another function to be called later.                                          |
| CDN               | Content Delivery Network. Servers around the world that serve your content from the closest one.   |
| client-side       | Runs in the browser. Same as 'frontend.'                                                           |
| component         | A reusable UI piece in React. A function that returns JSX.                                         |
| const             | Declares a constant variable in JavaScript.                                                        |
| cookie            | A small piece of data the browser stores and sends with every request to a domain.                 |
| CORS              | Cross-Origin Resource Sharing. Browser security rule that blocks cross-origin requests by default. |
| CSS               | Cascading Style Sheets. The styling language for the web.                                          |
| destructuring     | Syntax to extract values from arrays/objects in one line: `const [a, b] = arr;`                    |
| devtools          | Browser debugging panel. Press F12 to open.                                                        |
| env variable      | Environment variable. Configuration value (like passwords) stored outside code.                    |
| fetch             | JavaScript function for making network requests.                                                   |
| framework         | A pre-built foundation that handles common needs (Next.js is a framework).                         |
| frontend          | The browser part of an app — what users see and interact with.                                     |
| Git               | Version control system. Tracks code changes.                                                       |
| GitHub            | Website that hosts Git repositories online.                                                        |
| hot reload        | Dev feature that auto-refreshes your browser when code changes.                                    |
| HTML              | HyperText Markup Language. Defines page structure.                                                 |
| HTTP              | The protocol browsers and servers use to communicate.                                              |
| HttpOnly cookie   | A cookie that JavaScript can't read. Used for security (sessions).                                 |
| import            | Bring in tools/code from another file or library.                                                  |
| JSON              | JavaScript Object Notation. Data format that looks like JS objects but with stricter rules.        |
| JSX               | JavaScript XML. Syntax for writing HTML-like markup inside JS.                                     |
| library           | Pre-written code you can use (React, lodash, etc.).                                                |
| middleware        | Code that runs before requests are handled (e.g., auth checks).                                    |
| mount / unmount   | When a component appears on screen / disappears.                                                   |
| mutating state    | Modifying a state value directly. NEVER do this in React.                                          |
| Next.js           | Framework built on React with routing, API routes, etc.                                            |
| Node.js           | JavaScript runtime that runs outside the browser.                                                  |
| npm               | Node Package Manager. Installs JavaScript libraries.                                               |
| origin            | protocol + domain + port. Defines what's 'same site' for security.                                 |
| package.json      | File listing your project's dependencies.                                                          |
| proxy             | Code that forwards requests to another server.                                                     |
| props             | Data passed into a React component.                                                                |
| React             | JavaScript library for building UIs based on state.                                                |
| render            | Drawing the UI to screen based on current state.                                                   |
| repo / repository | A Git project. Usually corresponds to one folder of code.                                          |
| routing           | Mapping URLs to pages or handlers.                                                                 |
| server-side       | Runs on the server (Node.js), not in the browser.                                                  |
| serverless        | Code that only runs when called, scales automatically.                                             |
| state             | Data in a component that triggers re-renders when it changes.                                      |
| template literal  | Strings using backticks that allow `${variables}` inside.                                          |
| useEffect         | React hook for running code at specific times.                                                     |
| useState          | React hook for storing state in a component.                                                       |
| Vercel            | Hosting company optimized for Next.js apps.                                                        |

---

## Appendix B — Common errors

### Build / syntax errors

**"Expected a semicolon" / "Expression expected"**

Usually means an extra or missing brace, parenthesis, or bracket. Check the line shown plus a few lines around it. VS Code highlights mismatched braces — click a brace and look for its pair.

**"X is not defined"**

Variable or function used before it's declared, or imported, or after a typo. Check spelling and that you imported anything used from a library.

**"X is not a function"**

You're calling something that isn't a function. Often a typo or wrong import. Could also be data shape — e.g., expecting an array but got an object.

### Runtime errors

**"Cannot read property 'X' of undefined"**

Trying to access something on a value that doesn't exist. Use optional chaining (`?.`) to safely access:

```js
stock.ohlc.open       // crashes if ohlc is undefined
stock?.ohlc?.open     // safely returns undefined
```

**"Cannot convert undefined or null to object"**

Trying to use `Object.keys`/`entries` on `null` or `undefined`. Check that the value exists first.

**404 Not Found**

URL doesn't match any route. Check folder names — Next.js routes are case-sensitive.

### React-specific errors

**"Warning: Each child in a list should have a unique 'key' prop"**

When using `.map()` to render a list, each item needs a unique `key` prop:

```jsx
{stocks.map(s => <StockCard key={s.key} stock={s} />)}
```

**"Maximum update depth exceeded"**

You're calling a setState inside a useEffect without proper dependencies, causing an infinite loop. Check your useEffect dependency array.

### Network / API errors

**CORS errors in console**

You're making a cross-origin request the browser blocks. Use a server-side proxy.

**"401 Unauthorized" from Upstox**

Token expired (Upstox tokens expire daily at 3:30 AM IST). Generate a new one.

**Empty/no data returned**

Markets might be closed. Or wrong endpoint. Or bad parameters. Use `console.log` to inspect raw response.

### Deploy errors

**Vercel build fails**

Click into the deployment, view build logs. Usually a syntax error or missing env variable. Fix locally, push again.

**App works locally but breaks on Vercel**

Most common cause: missing env variable in Vercel. Check Settings → Environment Variables.

### Debugging strategy

1. Read the error message carefully — it usually points to the exact line
2. Check the browser console (F12) for client errors
3. Check the terminal running `npm run dev` for server errors
4. Add `console.log()` to inspect values
5. Comment out recent changes to isolate which one broke things
6. If stuck, do `git status` to see what you changed; consider reverting

---

## Appendix C — Useful commands

### Project setup

```bash
# Install all dependencies (after cloning or fresh setup)
npm install

# Run dev server
npm run dev

# Build for production
npm run build

# Stop dev server
Ctrl + C  (then Y)
```

### Git daily workflow

```bash
# Check what's changed
git status

# See actual diffs
git diff

# Stage and commit
git add .
git commit -m "what I changed"

# Push to GitHub (triggers Vercel deploy)
git push

# View commit history
git log --oneline
```

### Git emergency

```bash
# Discard ALL uncommitted changes (careful!)
git checkout .

# Discard a specific file's changes
git checkout app/page.jsx

# Reset a remote URL (if you typed wrong username)
git remote remove origin
git remote add origin https://github.com/USERNAME/REPO.git
```

### Windows file inspection

```bash
# Search inside a file
findstr /n "search-term" app\page.jsx

# Show all .jsx files
dir /s *.jsx

# Clear Next.js cache
rmdir /s /q .next
```

### Browser DevTools

```bash
# Open DevTools
F12

# Hard refresh (bypass cache)
Ctrl + Shift + R

# Console log object
console.log(obj)

# Inspect network requests
F12 → Network tab → click any row to see details
```

### Vercel

```bash
# Manual deploy (rarely needed)
# Just push to GitHub — Vercel auto-deploys

# View deployment logs
vercel.com/dashboard → project → deployments → click one

# Force redeploy
vercel.com/dashboard → project → deployments → ... → Redeploy
```

---

## You Built This

If you've read this far — congratulations. You went from "I don't even know what HTML is" to having a deployed, password-protected, real-time NSE F&O scanner with multi-segment confirmation logic.

That's a real engineering arc. Most people never ship anything. You did.

Some final thoughts to take with you:

- The hard part is rarely the code — it's having the IDEA. Your trading insights are the moat.
- Every time you change something, your understanding of the code deepens. Don't be afraid to break things — Git can always restore.
- Be skeptical of AI confidence (including mine). Always verify by running the code. I made many mistakes in this build that you caught.
- Keep an ideas notebook. The next feature is just an idea away.

Now go trade — and keep building.

*— end of notes —*