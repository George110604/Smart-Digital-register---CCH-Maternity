# Put the Smart Digital Register online (Render + GitHub)

Your app is ONE program: the server (server.js) also serves the website (the `public` folder).
So the easiest way is to put the whole thing on Render. You get one link, and no CORS setup is needed.
(GitHub is only used to store the code and feed Render.)

## 1. Send this folder to GitHub
Open a terminal in this folder (in VS Code: Terminal > New Terminal) and run, one line at a time:

    git init
    git add .
    git commit -m "Deploy-ready version"
    git branch -M main
    git remote add origin https://github.com/george110604/Smart-Digital-register---CCH-Maternity.git
    git push -u origin main --force

(`--force` replaces what is currently in that repo with this folder. If git says "remote origin already exists",
skip the `git remote add` line.)
Do NOT upload node_modules or any .db file. The .gitignore already blocks them.

## 2. Create the service on Render
1. Go to https://render.com and sign in with GitHub.
2. New > Web Service > pick the repo `Smart-Digital-register---CCH-Maternity`.
3. Fill in (Render usually detects these from render.yaml):
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance type: Free
4. Environment > add variable `NODE_VERSION` = `22.13.0` (the app needs Node 22.13 or newer).
5. Click Create / Deploy. Wait until it says "Live".

## 3. Open and log in
Open the link Render gives you (https://something.onrender.com). Log in with admin / admin123,
then go to Admin and change the passwords straight away.

## Good to know
- Free Render sleeps when idle. The first visit can take up to a minute. Open it before a demo.
- On the free plan the database (data/register.db) is wiped whenever Render restarts or redeploys.
  The 4 demo users are re-created automatically, but patient records are lost. Fine for a demo; for
  real data you need a paid disk (Render "Disks") or a hosted database.
- Use dummy patient data only on the public demo.

## Only if you still want the website on GitHub Pages
Copy the contents of the `public` folder to the repo you use for GitHub Pages, and in `config.js` set
    API_BASE: "https://YOUR-SERVICE.onrender.com"
The server already allows https://george110604.github.io (change with the ALLOWED_ORIGINS setting on Render).

## Run it on your own computer
    npm install
    npm test
    npm start
then open http://localhost:3000
