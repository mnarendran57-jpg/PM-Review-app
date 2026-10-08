# Moving Coaster development to the MacBook

This folder is **temporary**. It exists only to carry Claude Code's memory of this project
between two machines that cannot copy files to each other directly. Delete it once the Mac is
working — the instructions at the bottom say how.

Nothing in here is used by the application. Deleting it cannot break Coaster.

---

## What this folder is for

`claude-memory/` holds eleven short notes that Claude Code keeps about this project — how to run
it, that commits only happen when asked, that reports must read in plain English, that the
database is never deleted to reset state. They normally live outside the repository, on one
machine, and so they do not travel with a `git clone`. Without them, Claude Code on the Mac starts
knowing nothing about Coaster.

The local admin password has been removed from these copies. A fresh one is generated on the Mac
in step 4 below, so the old one is not needed and does not belong in version control.

---

## Setting up the Mac

Everything below is typed in the Mac's **Terminal** app.

### 1. Install the tools

Homebrew, which is how everything else gets installed:

    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

It prints two or three lines beginning `eval` when it finishes. Run those as well, or the `brew`
command will not be found.

    brew install node@24 git gh

**Node 24 is not optional.** Coaster reads its database through `node:sqlite`, which only exists
from Node 22.5 onwards. On anything older the backend will not start. Confirm with:

    node --version

### 2. Sign in to GitHub

    gh auth login

Choose GitHub.com, then HTTPS, then "Login with a web browser".

### 3. Get the code

    mkdir -p ~/Developer && cd ~/Developer
    git clone https://github.com/mnarendran57-jpg/PM-Review-app.git
    cd PM-Review-app

Keep it here rather than inside OneDrive. OneDrive and Git do the same job, and together they do
it badly: OneDrive syncs `node_modules` (tens of thousands of files, compiled for the wrong
operating system), it syncs the database file while it is being written, and two machines sharing
one folder produce conflict copies. Git already gives you the sync, and does it properly.

    cd backend && npm install
    cd ../frontend && npm install && cd ..

Never copy `node_modules` from the Windows machine. It contains binaries built for Windows.

### 4. Write backend/.env

Not in Git, deliberately — it holds secrets. Start from the template:

    cp backend/.env.example backend/.env
    open -e backend/.env

Eight entries. **None of them needs to be read off the old laptop:**

| Key | Where it comes from on the Mac |
|---|---|
| `ANTHROPIC_API_KEY` | A **new** key from console.anthropic.com |
| `PORT` | `3001` |
| `APP_PASSWORD_HASH` | Generated below |
| `JWT_SECRET` | Generated below |
| `R2_ENDPOINT` | Cloudflare dashboard → R2 |
| `R2_ACCESS_KEY_ID` | Cloudflare dashboard → R2 → Manage API Tokens |
| `R2_SECRET_ACCESS_KEY` | Same place |
| `R2_BUCKET` | Same place |

**Do not delete the old Anthropic key.** Render is using it, and revoking it takes the live site
down. Make an additional one.

From inside `backend/`, a signing secret for local logins:

    node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

And the local admin password — replace `PICK-A-PASSWORD` with one you choose, then put the output
in `APP_PASSWORD_HASH`:

    node -e "console.log(require('bcryptjs').hashSync('PICK-A-PASSWORD', 10))"

`APP_PASSWORD_HASH` matters more than it looks: it is what creates the first admin account on an
empty database. Leave it out and the app starts, logs "nobody can sign in", and locks you out.
With it, sign in as `admin@coaster.app` using the password you chose.

### 5. Give Claude Code its memory back

The destination folder is named after where the project lives, so Claude has to create it first.

Start Claude Code inside the project, then type `/exit`:

    cd ~/Developer/PM-Review-app && claude

Find the folder it just made — the top result is the one:

    ls -t ~/.claude/projects | head -3

Copy the notes in, substituting that folder name:

    mkdir -p ~/.claude/projects/PASTE-FOLDER-NAME/memory
    cp _mac-transfer/claude-memory/*.md ~/.claude/projects/PASTE-FOLDER-NAME/memory/

### 6. Check it works

    cd backend && npm test

One suite, `isolation.test.js`, needs the backend running and will fail with `ECONNREFUSED` if it
is not. Everything else should pass.

Then start the backend and the frontend and open http://localhost:3000.

---

## Finally: delete this folder

Once the Mac is signed in and the tests pass, on **either** machine:

    git rm -r _mac-transfer && git commit -m "The Mac is set up" && git push

It has done its job.
