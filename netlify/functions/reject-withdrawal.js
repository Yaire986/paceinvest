// This is the full code for netlify/functions/reject-withdrawal.js

// Import the Firebase Admin SDK
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK if not already initialized
// IMPORTANT: This relies on you having your service account key configured in your Netlify environment variables.
// Your service account JSON should be stored as a single environment variable named GOOGLE_CREDENTIALS.
if (admin.apps.length === 0) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}

const db = admin.firestore();

exports.handler = async (event, context) => {
    // 1. Check for POST method
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const { authToken, activityId } = JSON.parse(event.body);

        // 2. Authenticate the admin user
        const decodedToken = await admin.auth().verifyIdToken(authToken);
        if (!decodedToken.isAdmin) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Permission denied. User is not an admin.' }) };
        }
        
        // 3. Find the activity document
        // We must perform a collectionGroup query to find the activity document without knowing the user's ID beforehand.
        const activityQuery = await db.collectionGroup('activity').where(admin.firestore.FieldPath.documentId(), '==', activityId).limit(1).get();
        
        if (activityQuery.empty) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Activity document not found.' }) };
        }

        const activityDoc = activityQuery.docs[0];
        const activityData = activityDoc.data();
        
        // 4. Validate the transaction
        if (activityData.type !== 'withdrawal' || activityData.status !== 'Pending') {
            return { statusCode: 400, body: JSON.stringify({ error: 'Transaction is not a pending withdrawal.' }) };
        }

        const userId = activityDoc.ref.parent.parent.id;
        const userRef = db.collection('users').doc(userId);
        
        // 5. Perform the rejection and refund in a secure transaction
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new Error('User not found.');
            }

            const currentBalance = userDoc.data().availableBalance || 0;
            // The withdrawal amount is stored as a negative number, so we subtract it to add it back
            const newBalance = currentBalance - activityData.amount;
            
            // Update the user's balance
            transaction.update(userRef, { availableBalance: newBalance });
            
            // Update the activity status to 'Rejected'
            transaction.update(activityDoc.ref, { status: 'Rejected' });
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, message: 'Withdrawal rejected and funds returned.' })
        };

    } catch (error) {
        console.error('Error rejecting withdrawal:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message || 'An internal server error occurred.' })
        };
    }
};