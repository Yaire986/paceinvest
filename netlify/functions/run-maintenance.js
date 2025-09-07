// netlify/functions/run-maintenance.js
const admin = require('firebase-admin');

// Initialize Firebase Admin
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
} catch (e) { console.error('Failed to initialize Firebase Admin:', e); }

const db = admin.firestore();

const getDynamicDescription = (portData, portId) => {
    const location = portData.locationName || 'Unknown Location';
    const identifier = portData.portIdentifier || `Port #${portId.substring(0,4)}`;
    return `Routine maintenance checkup on ${location} (${identifier})`;
};

exports.handler = async function(event, context) {
  console.log("Starting weekly maintenance run...");
  try {
    const portsSnapshot = await db.collectionGroup('ports').where('status', '==', 'Active').get();
    if (portsSnapshot.empty) {
      return { statusCode: 200, body: "No active ports found to maintain." };
    }

    const promises = [];

    for (const portDoc of portsSnapshot.docs) {
      const portData = portDoc.data();
      const userId = portDoc.ref.parent.parent.id;
      const portId = portDoc.id;

      const activityRef = db.collection('users').doc(userId).collection('activity').doc();
      const promise = activityRef.set({
        type: 'maintenance',
        amount: 0, // No financial impact
        description: getDynamicDescription(portData, portId),
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        portId: portId
      });
      promises.push(promise);
    }

    await Promise.all(promises);
    const body = `Maintenance run complete. Logged ${promises.length} events.`;
    console.log(body);
    return { statusCode: 200, body };

  } catch (error) {
    console.error("Error during maintenance run:", error);
    return { statusCode: 500, body: "An error occurred during maintenance run." };
  }
};