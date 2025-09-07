const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
// The service account is automatically pulled from the environment variable
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
  }
} catch (e) {
  console.error('Firebase admin initialization error', e.stack);
}

const db = admin.firestore();

exports.handler = async (event, context) => {
  // 1. Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // 2. Check for the secret key to ensure the caller is trusted
  const providedSecret = event.headers['x-internal-secret'];
  if (providedSecret !== process.env.INTERNAL_API_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  try {
    const { userId, amount } = JSON.parse(event.body);

    // 3. Validate the incoming data
    if (!userId || typeof amount !== 'number' || amount <= 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid userId or amount provided.' }) };
    }

    // 4. Get a reference to the user's document
    const userRef = db.collection('users').doc(userId);

    // 5. Use FieldValue.increment to atomically update the earnings
    // This is safe even if multiple earnings happen at once.
    await userRef.update({
      lifetimeEarnings: admin.firestore.FieldValue.increment(amount)
    });

    console.log(`Successfully updated lifetimeEarnings for user ${userId} by ${amount}.`);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: `Earnings updated for user ${userId}.` })
    };

  } catch (error) {
    console.error('Error updating lifetime earnings:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal Server Error.' })
    };
  }
};