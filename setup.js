const fs = require('fs');
const path = require('path');

const NUM_PROFILES = 10;
const profilesDir = path.join(__dirname, 'uploads', 'profiles');

if (!fs.existsSync(profilesDir)) {
    fs.mkdirSync(profilesDir, { recursive: true });
}

for (let i = 1; i <= NUM_PROFILES; i++) {
    const profilePath = path.join(profilesDir, `w${i}`);
    if (!fs.existsSync(profilePath)) {
        fs.mkdirSync(profilePath);
        console.log(`✅ Created profile: w${i}`);
    }
}

console.log('Hive profiles setup complete.');
