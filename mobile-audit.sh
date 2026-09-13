#!/bin/bash
# mobile-audit.sh — render Content Shrimp at true iPhone width, screenshot +
# measure every screen for mobile layout issues (overflow / tiny tap targets /
# overlapping fixed elements). Uses agent-browser (real device emulation), which
# — unlike a desktop browser window — actually fires the <=600px mobile CSS.
#
# Run on your Mac:
#   cd ~/boring-content-engine-deploy
#   bash mobile-audit.sh
# First run installs agent-browser + its browser and asks you to log in once
# (the session is saved, so later runs skip it). Screenshots land in
# ./mobile-audit-shots/ and measurements print to the terminal.

set -e
APP="${APP_URL:-https://contentshrimp.com/app.html}"
OUT="$(cd "$(dirname "$0")" && pwd)/mobile-audit-shots"
mkdir -p "$OUT"
export AGENT_BROWSER_SESSION_NAME=cs-mobile          # persists your login
export AGENT_BROWSER_SCREENSHOT_DIR="$OUT"

command -v agent-browser >/dev/null 2>&1 || npm i -g agent-browser
agent-browser install >/dev/null 2>&1 || true

ab(){ agent-browser "$@"; }

# --- measurement run inside the page: overflow / small taps / fixed elements ---
read -r -d '' MEASURE <<'JS' || true
(function(){var vw=innerWidth,dW=document.documentElement.scrollWidth,off=[],tap=[],fx=[];
var a=document.querySelectorAll('body *');for(var i=0;i<a.length;i++){var e=a[i],r=e.getBoundingClientRect();
if(!r.width||!r.height)continue;var c=getComputedStyle(e);if(c.visibility=='hidden'||c.display=='none'||c.opacity=='0')continue;
if(r.right>vw+1&&r.width<=vw+80&&r.left>=-2)off.push(e.tagName+(e.id?'#'+e.id:'')+' r'+Math.round(r.right));
var k=/^(A|BUTTON)$/.test(e.tagName)||e.getAttribute('role')=='button';
if(k&&(e.innerText||'').trim()&&(r.width<40||r.height<34))tap.push((e.innerText||'').trim().slice(0,16)+' '+Math.round(r.width)+'x'+Math.round(r.height));
if(c.position=='fixed'||c.position=='sticky')fx.push((e.id||(''+e.className).trim().split(' ')[0])+' ['+[r.left,r.top,r.right,r.bottom].map(Math.round)+']');}
return JSON.stringify({vw:vw,hScroll:dW>vw+1,overflow:off.slice(0,6),smallTaps:tap.slice(0,8),fixed:fx.slice(0,8)});})()
JS

ab set device "iPhone 16"
ab open "$APP"; sleep 4

if agent-browser eval "/Send Magic Link|Enter your email to start/i.test(document.body.innerText)" | grep -qi true; then
  echo ""
  echo ">> A login screen is showing. Log in in the agent-browser window (magic link),"
  echo ">> then press ENTER here to continue. (Saved for next time.)"
  read -r _
  ab open "$APP"; sleep 4
fi

capture(){ # $1 = nav JS, $2 = name
  ab eval "$1" >/dev/null 2>&1 || true; sleep 1
  printf "### %-16s " "$2"; ab eval "$MEASURE"
  ab screenshot "$OUT/$2.png" >/dev/null 2>&1 || true
}

capture "switchView('today')"     quick-post
capture "switchView('ideas')"     ideas
capture "switchView('pipeline')"  pipeline
capture "moreGo('create')"        remix
capture "moreGo('idea')"          idea-catcher
capture "moreGo('questions')"     what-people-search
capture "moreGo('notebook')"      notebook
capture "moreGo('blog')"          blog
capture "moreGo('viral')"         viral-lab
capture "moreGo('meme')"          meme-image
capture "moreGo('dfy')"           done-for-you
capture "toggleSettings&&toggleSettings()" settings
capture "openBrain&&openBrain()"  brain

echo ""
echo "Done. Screenshots + measurements in: $OUT"
