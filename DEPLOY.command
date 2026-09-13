#!/bin/zsh
# One-click prod deploy for Content Shrimp
cd "$HOME/boring-content-engine-deploy" || exit 1
vercel --prod
echo ""
echo "Done. Press any key to close."
read -k1
