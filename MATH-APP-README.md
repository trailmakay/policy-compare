# 📷 Math Photo Tutor

Take a picture of any math problem (up to pre-calc). It reads it, solves it, and
teaches the student how to do it themselves. Works on any phone through the
browser — and you choose exactly who can use it with a passcode.

**Files:** `math-server.js` (the tiny server) + `math.html` (the page). It reuses
the same `.env` API key as your policy app.

---

## Try it on your own phone first (2 minutes)

1. In Terminal, from this folder, start it:
   ```
   MATH_PASSCODE=pick-any-code npm run math
   ```
   You'll see: `Math Photo Tutor running on http://localhost:3100`

2. On the **same computer**, open <http://localhost:3100> in a browser to confirm
   it works (enter the passcode you chose, snap or upload a math problem).

That proves everything works. To use it from your *phone* anywhere, and to share
it with people, put it online — see below.

---

## Put it online & get it on phones (≈5 minutes, free)

The simplest free host that runs a Node server like this is **Render**:

1. Make a free account at <https://render.com>.
2. New → **Web Service** → connect this project (or drag the folder in).
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `node math-server.js`
   - **Environment variables** (this is the important part):
     - `ANTHROPIC_API_KEY` = your key (same one in your `.env`)
     - `MATH_PASSCODE` = the code you'll give to people you choose
4. Deploy. Render gives you a public link like `https://your-app.onrender.com`.

**On each phone:** open that link once → tap the browser's **Share / menu** →
**"Add to Home Screen."** Now it's an icon that opens fullscreen, just like an app.

---

## Sharing with "people you choose"

Text them two things: **the link** and **the passcode**. No passcode = no access.
To cut someone off later, change `MATH_PASSCODE` and re-share the new code with the
people you still want to have it. (Everyone just re-enters the new code once.)

---

## Knobs you can turn (all optional)

| Environment variable | What it does | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Your Claude API key (required) | — |
| `MATH_PASSCODE` | The code people must enter | *(none = open to anyone with the link)* |
| `MATH_MODEL` | `claude-opus-4-8` (most accurate) or `claude-haiku-4-5` (faster/cheaper) | `claude-opus-4-8` |
| `MATH_PORT` | Port to run on | `3100` |

**Cost:** each solved problem is a few cents at most on Opus, less on Haiku. Only
the people with your passcode can spend it.

---

## What it does well / its limits

- **Great at:** arithmetic, fractions, percentages, algebra, geometry, trig,
  functions, basic limits — clean printed or neat handwritten problems.
- **Struggles with:** blurry/dark photos and very messy handwriting (it will ask
  for a clearer picture rather than guess), and anything well beyond pre-calc.
- It double-checks its own arithmetic and shows the check, so wrong answers are
  rare — but for a graded assignment, treat it as a tutor, not the final word.
