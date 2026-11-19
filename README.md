# OC Level Maintainer Web App

A web interface for OpenComputers level maintainer in GregTech New Horizons modpack!  
Add and change items to stock on your AE2 network, see currrent stocked item counts through website & even remotely!

### **Currently only works for version 2.9 of GTNH**
(2.8 uses AE2FC which needs a bit of different handling ~~which I'm too lazy for~~)

> The OC maintainer script is based on [Echoloquate/Level-Maintainer](https://github.com/Echoloquate/Level-Maintainer),  
> which is forked from [Niels1006/Level-Maintainer](https://github.com/Niels1006/Level-Maintainer).

# Disclaimer
Regarding setting up server, everything should be completely safe as long as at minimum you set a browser key and some sort of API key string. I'm not responsible if you decide to share your link to public with no password, letting them change maintained values to weird values.

## How it works

One OC computer runs ingame, maintaining your AE2 stock and syncing with the web app  
Web app runs on either local or on a server

# Open Computers Setup

### Maintainer  
> **This computer needs Adapter** touching main crafting network's ME Interface, and an **Internet Card**

To install, run
```
wget https://raw.githubusercontent.com/Soycakes/OC-WebInterface-Maintainer/main/oc-scripts/install-maintainer.lua && install-maintainer
```

To run the program, run
```
maintainer
```

> Upgrading from the old 2-computer setup? Delete the maintainer's old `config.lua` before running the installer, and the Connector computer and Linked Cards are no longer needed.

---

## Web Server Setup

### Option 1 - Cloudflare (Free, always on, recommended)

Cloudflare runs the website for you for free, so it keeps working while your PC is off.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Soycakes/OC-WebInterface-Maintainer)

1. Click the button above, sign in (or make a free Cloudflare account) and connect GitHub
2. When asked, set `BROWSER_PASSWORD` (password for your website) and `API_KEY` (any random string, also goes in Maintainer OC's config.lua). Both are required.
3. Deploy. Your website URL is shown at the end, looking like `https://oc-maintainer.your-name.workers.dev`
4. Add the website URL and API key in Maintainer OC's config.lua (type `edit config.lua`, set `server = "https://your-url-here",` and `api_key = "your-api-key",` then `Ctrl+S Ctrl+W` to save&close)

> Forgot to set the password or API key? In Cloudflare go to Workers & Pages -> oc-maintainer -> Settings -> Variables and Secrets, add them there and the site will start working.

> Moving from Railway? Click Export on your old site, then Import on the new one. History doesn't carry over.

---

### Option 2 - Local (Single player / your own PC or VPS)

Needs [Node.js](https://nodejs.org) 22 or newer.  
Download the project here, then run Start.bat  
On first time running, you'll have an option to set :  
1. password (Not needed if only you can reach this PC, leave blank)  
2. API key (set anything, same value goes in Maintainer OC's config.lua)  
3. port  (3000 is fine for default)  

all of these can be changed later in `.dev.vars`

Open `http://localhost:3000`

> Note - You may have to whitelist local address in OpenComputer's config. Configs -> OpenComputers.cfg  
> Find `filteringRules` inside and add `"allow ip:127.0.0.1",`

---

### Open Computer Configs

As said above, you need to change 'Maintainer' OC's config.lua

```lua
return {
  server = "https://oc-maintainer.your-name.workers.dev", -- Your website URL
  api_key = "your-api-key", -- Same as API_KEY on the website
  network_id = "main", -- Don't touch this, WIP
  timeout = 5, -- Seconds to wait for the web server before giving up on that sync
  debug = true, -- Shows ME call count and time on screen
}
```

Items to maintain and the check interval are set on the website.

---

Actually using the site below here : WIP  
  
  In sorting -> Custom, you can drag LEFT in the blank area left of the handle to create bracket groups similar to NEI Calculator (literally click drag in those areas like you would with NEI calculator groupping)
    
  Bracket groups can be clicked to collapse then moved around and renamed. (Enable/Disable on collapse group disables/enables all things in the group)

  The UX for this isn't that good, so likely this will be reworked.
