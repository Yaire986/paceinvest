// netlify/functions/update-balance-on-demand.js
const admin = require('firebase-admin');

// Initialize Firebase Admin
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
} catch (e) { console.error('Failed to initialize Firebase Admin:', e); }

const db = admin.firestore();

exports.handler = async function(event, context) {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { authToken, activityId } = JSON.parse(event.body);
    if (!authToken || !activityId) {
      return { statusCode: 400, body: 'Missing authToken or activityId.' };
    }

    // 1. Verify user's identity using the token from the client
    const decodedToken = await admin.auth().verifyIdToken(authToken);
    const uid = decodedToken.uid;

    // 2. Get a reference to the specific activity document
    const activityRef = db.collection('users').doc(uid).collection('activity').doc(activityId);
    
    // Use a Firestore Transaction to ensure data consistency
    return db.runTransaction(async (transaction) => {
        const activityDoc = await transaction.get(activityRef);

        if (!activityDoc.exists) {
            throw new Error("Activity document not found.");
        }

        const activityData = activityDoc.data();

        // 3. Prevent this function from running twice on the same activity
        if (activityData.balanceUpdated === true) {
            console.log("Balance for this activity has already been updated.");
            return { statusCode: 200, body: 'Balance already updated.' }; // Not an error, just acknowledge
        }
        
        // 4. Check that the activity type is one that should affect the balance
        const validTypes = ['withdrawal', 'deposit'];
        if (!validTypes.includes(activityData.type)) {
            console.log(`Skipping balance update for irrelevant type: ${activityData.type}`);
            // Mark it as processed so we don't check it again
            transaction.update(activityRef, { balanceUpdated: true });
            return { statusCode: 200, body: `Skipped type: ${activityData.type}` };
        }

        // 5. Update the user's balance and mark the activity as processed
        const userRef = db.collection('users').doc(uid);
        transaction.update(userRef, {
            availableBalance: admin.firestore.FieldValue.increment(activityData.amount)
        });
        transaction.update(activityRef, {
            balanceUpdated: true
        });

        console.log(`Successfully updated balance for user ${uid} by ${activityData.amount}`);
        return; // Firestore transactions require a return at the end
    }).then(() => {
        return { statusCode: 200, body: 'Balance updated successfully.' };
    });

  } catch (error) {
    console.error("Error updating balance:", error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "An internal error occurred while updating balance." }),
    };
  }
};