
import fetch from 'node-fetch';

async function check() {
    try {
        const res = await fetch('http://localhost:7300/api/context');
        const list = await res.json();
        console.log(`Found ${list.length} sessions`);

        if (list.length > 0) {
            const key = list[0].key;
            console.log(`Checking session: ${key}`);
            const res2 = await fetch(`http://localhost:7300/api/context/${encodeURIComponent(key)}`);
            const msgs = await res2.json();
            console.log(`Got ${msgs.length} messages`);
            const lastMsg = msgs[msgs.length - 1];
            console.log('Last message:', JSON.stringify(lastMsg, null, 2));

            if (lastMsg.at_users_details) {
                console.log('at_users_details FOUND');
            } else {
                console.log('at_users_details MISSING');
            }
        }
    } catch (e) {
        console.error(e);
    }
}

check();
