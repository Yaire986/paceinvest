// netlify/functions/reset-monthly-stats.js
const admin = require('firebase-admin');

// Initialize Firebase Admin
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
} catch (e) {
  console.error('Failed to initialize Firebase Admin:', e);
}
const db = admin.firestore();

exports.handler = async function(event, context) {
  console.log("Starting Monthly Stats Reset...");

  try {
    const usersSnapshot = await db.collection('users').get();
    
    if (usersSnapshot.empty) {
      return { statusCode: 200, body: "No users found to reset." };
    }

    const batches = [];
    let batch = db.batch();
    let operationCount = 0;

    // Iterate through all users
    for (const userDoc of usersSnapshot.docs) {
      const userRef = db.collection('users').doc(userDoc.id);

      // 1. Reset USER Level Monthly Stats
      batch.update(userRef, {
        monthlyEarnings: 0,
        monthlyKwhDelivered: 0,
        monthlySessions: 0,
        monthlyCo2Offset: 0,
        lastMonthlyReset: admin.firestore.FieldValue.serverTimestamp()
      });
      operationCount++;

      // 2. Reset PORT Level Monthly Stats
      // We must fetch the ports for this specific user
      const portsSnapshot = await userRef.collection('ports').get();
      
      for (const portDoc of portsSnapshot.docs) {
          batch.update(portDoc.ref, {
             monthlyEarnings: 0,
             // This is critical for the Utilization calculation to work correctly next month
             monthlyDurationMinutes: 0, 
             utilization: 0
          });
          operationCount++;

          // Firestore Batch Limit is 500 operations
          // We check inside the inner loop to be safe
          if (operationCount >= 450) {
            batches.push(batch.commit());
            batch = db.batch();
            operationCount = 0;
          }
      }

      // Check again after finishing a user's ports
      if (operationCount >= 450) {
        batches.push(batch.commit());
        batch = db.batch();
        operationCount = 0;
      }
    }

    // Commit any remaining operations in the final batch
    if (operationCount > 0) {
      batches.push(batch.commit());
    }

    await Promise.all(batches);

    const message = `Successfully reset monthly stats and utilization for ${usersSnapshot.size} users.`;
    console.log(message);
    return { statusCode: 200, body: message };

  } catch (error) {
    console.error("Error resetting monthly stats:", error);
    return { statusCode: 500, body: "Internal Server Error during reset." };
  }
};