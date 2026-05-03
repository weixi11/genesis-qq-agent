const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, 'src/web/public/css/style.css');
const musicCssPath = path.join(__dirname, 'src/web/public/css/music_card.css');

try {
    let content = fs.readFileSync(cssPath, 'utf8');

    // Find the last known good class
    const marker = '.reply-preview.empty';
    const markerIndex = content.lastIndexOf(marker);

    if (markerIndex !== -1) {
        // Find the closing brace for this rule
        // We scan forward from the marker
        const closingBraceIndex = content.indexOf('}', markerIndex);

        if (closingBraceIndex !== -1) {
            // Truncate everything after the closing brace
            const cleanContent = content.substring(0, closingBraceIndex + 1);

            // Read valid music card CSS
            const musicCss = fs.readFileSync(musicCssPath, 'utf8');

            // Write back
            fs.writeFileSync(cssPath, cleanContent + '\n\n' + musicCss, 'utf8');
            console.log('Successfully fixed style.css');
        } else {
            console.error('Could not find closing brace for .reply-preview.empty');
        }
    } else {
        console.error('Could not find .reply-preview.empty marker');
    }
} catch (e) {
    console.error('Error fixing CSS:', e);
}
