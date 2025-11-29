// netlify/functions/submit-withdrawal.js
const admin = require('firebase-admin');

try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
  }
} catch (e) { console.error('Firebase admin initialization error', e.stack); }

const db = admin.firestore();

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { authToken, amount, details, code } = JSON.parse(event.body);

    // Validation
    if (!authToken || !amount || !details || !code) return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields.' }) };
    if (typeof amount !== 'number' || amount <= 0) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid withdrawal amount.' }) };

    const decodedToken = await admin.auth().verifyIdToken(authToken);
    const uid = decodedToken.uid;
    const userRef = db.collection('users').doc(uid);

    await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) throw new Error('User not found.');

        const userData = userDoc.data();
        
        // 1. Validate Withdrawal Code
        if (!userData.withdrawalCode || code !== userData.withdrawalCode) {
            throw new Error('Invalid withdrawal code.');
        }
        
        // 2. Check Balance
        const currentBalance = userData.availableBalance || 0;
        if (amount > currentBalance) {
            throw new Error('Insufficient funds.');
        }

        // 3. Create Activity Record
        const newActivityRef = userRef.collection('activity').doc();
        transaction.set(newActivityRef, {
            type: 'withdrawal',
            status: 'Pending',
            amount: -amount, // Visual representation
            description: `Withdrawal to ${details.method}`,
            details: details,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        // 4. === CRITICAL FIX: DEDUCT BALANCE IMMEDIATELY ===
        // This prevents the user from spending the money again while it's pending.
        transaction.update(userRef, {
            availableBalance: admin.firestore.FieldValue.increment(-amount)
        });
    });

    return { statusCode: 200, body: JSON.stringify({ success: true, message: 'Withdrawal request submitted.' }) };

  } catch (error) {
    console.error('Error submitting withdrawal:', error);
    if (error.message === 'Invalid withdrawal code.') return { statusCode: 401, body: JSON.stringify({ error: 'The withdrawal code is incorrect.' }) };
    if (error.message === 'Insufficient funds.') return { statusCode: 400, body: JSON.stringify({ error: 'Withdrawal amount exceeds available balance.' }) };
    return { statusCode: 500, body: JSON.stringify({ error: 'An internal server error occurred.' }) };
  }
};