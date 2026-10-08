# Setting up Coaster on the MacBook

**Read this page on the Mac**, not on the old laptop. Every code box below has a copy button on
the right — click it, then paste into Terminal with `⌘ + V`. That way nothing has to travel
between the two machines.

Nothing here is typed from the Windows laptop. Every value you need is either generated on the Mac
or read from a website you log into on the Mac.

This folder is temporary and deletes itself in the last step.

---

## Before you start

Open **Terminal**: press `⌘ + Space`, type `terminal`, press Return.

A window opens with a blinking cursor. Every command goes there: paste it, press Return, wait for
the cursor to come back before the next one.

Allow about 40 minutes. Most of that is waiting.

---

# Part 1 — Install the tools

## Step 1. Install Homebrew

Homebrew installs everything else.

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

It asks for your Mac login password. **Nothing appears on screen while you type it** — that is
normal, not a frozen window. Type it and press Return.

Takes 5–10 minutes.

**Do not skip the end.** When it finishes it prints two or three lines beginning with `eval`.
Copy those lines from your own Terminal window and run them. Without this, the next step fails
with "command not found".

## Step 2. Check Homebrew is working

```
brew --version
```

Expect `Homebrew 4.something`. If you get "command not found", the `eval` lines from step 1 were
not run.

## Step 3. Install Node, Git and the GitHub tool

```
brew install node@24 git gh
```

## Step 4. Check the Node version

```
node --version
```

**It must begin with `v24`.** Anything below v22.5 will not work: Coaster reads its database
through a feature that does not exist in older versions, and the backend will refuse to start
without explaining why. If the number is lower, stop here and ask.

---

# Part 2 — Download Coaster

## Step 5. Sign in to GitHub

```
gh auth login
```

Four questions. Answer with the arrow keys and Return:

1. **GitHub.com**
2. **HTTPS**
3. **Yes** — authenticate Git with your GitHub credentials
4. **Login with a web browser**

It shows a short code like `ABCD-1234`. Press Return, a browser opens, type the code, approve.

## Step 6. Download the project

```
mkdir -p ~/Developer && cd ~/Developer && git clone https://github.com/mnarendran57-jpg/PM-Review-app.git
```

Keep it here rather than in OneDrive. Git already keeps the two machines in step, and OneDrive
trying to do the same job at the same time is what produces conflict copies and, eventually, a
damaged database file.

## Step 7. Install the backend's parts

```
cd ~/Developer/PM-Review-app/backend && npm install
```

Yellow warnings are normal. Red `ERR!` lines are not — stop and ask if you see them.

## Step 8. Install the frontend's parts

```
cd ~/Developer/PM-Review-app/frontend && npm install
```

---

# Part 3 — The settings file

Coaster needs eight settings that are deliberately kept out of GitHub because they are secrets.
You will create all eight fresh on the Mac.

## Step 9. Create the file and open it

```
cp ~/Developer/PM-Review-app/backend/.env.example ~/Developer/PM-Review-app/backend/.env && open -e ~/Developer/PM-Review-app/backend/.env
```

TextEdit opens with a list of settings. **Leave it open** — the next steps fill it in.

## Step 10. Choose your Coaster password

Decide on a password for logging into Coaster on this Mac, then **replace the words
`PICK-A-PASSWORD` below with it**, keeping the single quotes around it.

```
cd ~/Developer/PM-Review-app/backend && node -e "console.log(require('bcryptjs').hashSync('PICK-A-PASSWORD', 10))"
```

It prints a long scrambled line starting `$2b$10$`. Put that line after `APP_PASSWORD_HASH=` in
TextEdit.

**Write your password down somewhere.** It is how you will sign in, and it cannot be recovered
from the scrambled version.

This setting matters more than it looks: it is what creates the first administrator account on an
empty database. Leave it blank and Coaster starts, writes "nobody can sign in" to the log, and
locks you out of your own app.

## Step 11. Generate the signing key

```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Put the long line after `JWT_SECRET=`.

## Step 12. Set the port

In TextEdit, make this line read exactly:

```
PORT=3001
```

## Step 13. Create a new Anthropic key

In a browser on the Mac: **console.anthropic.com** → **API Keys** → **Create Key**. Call it
`macbook`. Put it after `ANTHROPIC_API_KEY=`.

**Leave your existing key alone.** Render uses it to run the live site. Deleting or rotating it
takes Coaster down for everyone. You are adding a second key, not moving the first.

## Step 14. Fetch the four Cloudflare values

In a browser: **dash.cloudflare.com** → **R2**.

- `R2_BUCKET=` — the bucket name shown on that page
- `R2_ENDPOINT=` — open the bucket → **Settings** → the **S3 API** address
- `R2_ACCESS_KEY_ID=` and `R2_SECRET_ACCESS_KEY=` — **Manage API Tokens** → **Create API Token**,
  with Read & Write permission

The secret key is displayed **once only**. Copy it straight into TextEdit.

## Step 15. Save the file

`⌘ + S`, then close TextEdit.

---

# Part 4 — Claude Code

## Step 16. Install it

```
npm install -g @anthropic-ai/claude-code
```

## Step 17. Start it once inside the project

```
cd ~/Developer/PM-Review-app && claude
```

A browser opens to sign in to Anthropic — the same account as on the old laptop.

Once it is running, type `/exit` and press Return. This first run creates the folder the next step
needs.

## Step 18. Copy the project notes into place

This one command finds the folder Claude just made, copies the eleven notes in, and lists them
back so you can check.

```
C=$(ls -t ~/.claude/projects | head -1) && mkdir -p ~/.claude/projects/"$C"/memory && cp ~/Developer/PM-Review-app/_mac-transfer/claude-memory/*.md ~/.claude/projects/"$C"/memory/ && ls ~/.claude/projects/"$C"/memory
```

**You should see eleven file names.** If you see nothing, step 17 did not complete — run it again.

These notes are what Claude Code knows about this project: that it never commits without being
asked, that reports are written in plain English for clients who are not builders, that the
database is migrated rather than deleted. Without them the Mac starts from nothing.

---

# Part 5 — Run it

## Step 19. Start the backend

```
cd ~/Developer/PM-Review-app/backend && npm run dev
```

Expect `PM Review backend running on http://0.0.0.0:3001`.

**Leave this window open and running.** Closing it stops Coaster.

## Step 20. Start the frontend in a new window

Press `⌘ + N` for a second Terminal window, then:

```
cd ~/Developer/PM-Review-app/frontend && npm run dev
```

Leave this one open too.

## Step 21. Open Coaster

Go to **http://localhost:3000**

Sign in with `admin@coaster.app` and the password you chose in step 10.

---

# Part 6 — Check and tidy up

## Step 22. Run the tests

A third Terminal window (`⌘ + N`):

```
cd ~/Developer/PM-Review-app/backend && npm test
```

Everything should pass. One suite, `isolation.test.js`, needs the backend running — if step 19 is
still going, it passes too.

## Step 23. Delete this folder

Only once everything above works:

```
cd ~/Developer/PM-Review-app && git rm -r _mac-transfer && git commit -m "The Mac is set up" && git push
```

---

# If something goes wrong

Say which step number, and what the red text says.

| What you see | Step | Cause |
|---|---|---|
| `brew: command not found` | 1 | The `eval` lines were not run |
| Node version below v22.5 | 4 | Wrong Node; Coaster will not start |
| `npm install` red `ERR!` | 7 or 8 | Usually Node again |
| "nobody can sign in" in the log | 10 | `APP_PASSWORD_HASH` is empty |
| No files listed | 18 | Claude Code was not started first |

---

# What to expect afterwards

Coaster on the Mac starts with an **empty database** — no projects, no documents. That is
deliberate: the old laptop's database holds real client data and does not belong in GitHub. Add a
test project and work from there.

Nothing about the live service changes. The published Coaster site, the Render backend and the
Cloudflare files carry on exactly as before, and the Windows laptop keeps working too. This is a
second workshop, not a move — you can use either machine, and `git pull` brings each one up to
date with the other.
