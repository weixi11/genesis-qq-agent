# Git Basics For This Project

## 1. Git is for what

Git helps you:

- see what changed
- save checkpoints with commit history
- go back when something breaks
- create branches for new work

## 2. First-time setup on your machine

Run these once and replace the values with your own:

```powershell
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

Check the result:

```powershell
git config --global --get user.name
git config --global --get user.email
```

## 3. Daily commands you will use most

See current changes:

```powershell
git status
```

See detailed file differences:

```powershell
git diff
```

Stage one file:

```powershell
git add src/index.ts
```

Stage everything currently changed:

```powershell
git add .
```

Create a commit:

```powershell
git commit -m "feat: add xxx"
```

View commit history:

```powershell
git log --oneline --graph --decorate -20
```

## 4. Undo common mistakes

Discard edits in one file before staging:

```powershell
git restore src/index.ts
```

Unstage a file you added by mistake:

```powershell
git restore --staged src/index.ts
```

See what is staged but not committed yet:

```powershell
git diff --cached
```

## 5. Branch workflow

Create and switch to a new branch:

```powershell
git switch -c feature/my-change
```

Go back to the main branch:

```powershell
git switch main
```

## 6. Suggested flow for this repo

When you start work:

```powershell
git status
```

After you finish a small change:

```powershell
git add .
git commit -m "feat: describe the change"
```

Before a risky refactor:

```powershell
git switch -c refactor/some-area
```

## 7. Connect to GitHub later

If you create a GitHub repo for this project:

```powershell
git remote add origin <your-repo-url>
git push -u origin main
```

After that, future pushes are usually:

```powershell
git push
```

## 8. Important notes for this project

- `.env` is ignored, so secrets should not be committed.
- `node_modules/` and `dist/` are ignored, so Git stays clean.
- Runtime database files under `data/` are ignored too.
- Use small commits with clear messages. That makes rollback much easier.
