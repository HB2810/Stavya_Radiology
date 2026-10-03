import { useEffect, useState } from 'react';

// Texts below are the agency app's own English / Hindi / Gujarati wording (registration hints, consent statement).
export const LANGS = { en: 'English', hi: 'हिन्दी', gu: 'ગુજરાતી' };
let lang = localStorage.getItem('language') || 'en';
const listeners = new Set();
export const setLang = (l) => { lang = l; localStorage.setItem('language', l); listeners.forEach((f) => f(l)); };
export function useLang() { const [l, setL] = useState(lang); useEffect(() => { listeners.add(setL); return () => listeners.delete(setL); }, []); return [l, setLang]; }

export const WIZARD_HINTS = {
  en: [
    ['1 Verify your identity using Aadhar card, Email, or Phone.', '2 Make sure you have your Aadhar card or access to your email/phone for verification.', '3 Choose your preferred verification method before proceeding.'],
    ['1 An OTP will be sent to your chosen method (Email/Phone) for verification.', '2 Enter the OTP correctly within the given time to proceed.', "3 If you don't receive the OTP, click 'Resend OTP'."],
    ['1 Fill in your personal details to complete the registration process.', '2 Make sure all the details are correct before submitting.', '3 Your information will be securely stored and processed.'],
    ['1 Review the selected diagnosis details carefully.', '2 Apply any applicable discounts and ensure charges are accurate.', "3 Click 'Save' to confirm and proceed."]
  ],
  hi: [
    ['1 अपना पहचान सत्यापित करने के लिए आधार कार्ड, ईमेल, या फोन का उपयोग करें।', '2 सत्यापन के लिए अपने आधार कार्ड या ईमेल/फोन का उपयोग करने के लिए सुनिश्चित करें।', '3 आगे बढ़ने से पहले अपनी पसंदीदा सत्यापन विधि चुनें।'],
    ['1 एक ओटीपी आपके चुने गए विधि (ईमेल/फोन) पर भेजा जाएगा।', '2 ओटीपी को सही तरीके से समय सीमा के भीतर दर्ज करें।', "3 अगर आपको ओटीपी नहीं मिलता है, तो 'ओटीपी फिर से भेजें' पर क्लिक करें।"],
    ['1 पंजीकरण प्रक्रिया को पूरा करने के लिए अपने व्यक्तिगत विवरण भरें।', '2 सुनिश्चित करें कि सभी विवरण सही हैं, फिर सबमिट करें।', '3 आपकी जानकारी को सुरक्षित रूप से संग्रहीत और संसाधित किया जाएगा।'],
    ['1 चयनित निदान विवरण को ध्यानपूर्वक जांचें।', '2 कोई भी लागू छूट लागू करें और शुल्क की सटीकता सुनिश्चित करें।', "3 पुष्टि करने और आगे बढ़ने के लिए 'सेव' पर क्लिक करें।"]
  ],
  gu: [
    ['1 તમારું ઓળખાણ આધાર કાર્ડ, ઇમેલ અથવા ફોન દ્વારા પુષ્ટિ કરો.', '2 પુષ્ટિકરણ માટે તમારું આધાર કાર્ડ અથવા ઇમેલ/ફોનનું એક્સેસ થવા માટે સુનિશ્ચિત કરો.', '3 આગળ વધવાનો પહેલા તમારી પસંદગીના પુષ્ટિ પદ્ધતિને પસંદ કરો.'],
    ['1 એક OTP તમારા પસંદ કરેલા પદ્ધતિ (ઇમેલ/ફોન) પર મોકલવામાં આવશે.', '2 OTP ને યોગ્ય રીતે અને સમયમર્યાદામાં દાખલ કરો.', "3 જો તમને OTP પ્રાપ્ત ન થાય તો 'OTP ફરી મોકલો' પર ક્લિક કરો."],
    ['1 પર્સનલ ડીટેઇલ્સ ભરવા માટે નોંધણી પ્રક્રિયા પૂર્ણ કરો.', '2 ખાતરી કરો કે તમામ વિગતો સાચી છે, ત્યારબાદ સબમિટ કરો.', '3 તમારી માહિતી સુરક્ષિત રીતે સંગ્રહિત અને પ્રોસેસ થશે.'],
    ['1 પસંદ કરેલા નિદાન વિગતોથી ખ્યાલ મેળવો.', '2 લાગુ છૂટને લાગુ કરો અને ખર્ચોની ચોકસાઈની ખાતરી કરો.', "3 ખાતરી કરવા અને આગળ વધવા માટે 'સેવ' પર ક્લિક કરો."]
  ]
};

export const CONSENT_STATEMENT = {
  en: (scan) => ({ intro: `I solemnly give consent for the ${scan} procedure. I confirm that:`, points: ['I have been thoroughly explained about the procedure involved.', 'I am aware of the potential side effects of contrast, anesthesia & medicines.', "I hereby declare that the center staff won't be held responsible for any mishaps.", 'I understand that the images may be used for research/education without personal details.'] }),
  gu: (scan) => ({ intro: `હું ${scan} પ્રક્રિયા માટે સંપૂર્ણ સંમતિ આપું છું. હું નિશ્ચિત કરું છું કે:`, points: ['મને સામેલ પ્રક્રિયા વિશે સંપૂર્ણ રીતે સમજાવવામાં આવ્યું છે.', 'હું કોન્ટ્રાસ્ટ, એનેસ્થેસિયા અને દવાઓની સંભવિત આડઅસરોથી વાકેફ છું.', 'હું આથી જાહેર કરું છું કે કોઈ પણ અઘટિત ઘટના માટે કેન્દ્રના કર્મચારીઓ જવાબદાર નહીં ગણાય.', 'હું સમજું છું કે વ્યક્તિગત વિગતો વિના સંશોધન/શિક્ષણ માટે છબીઓનો ઉપયોગ થઈ શકે છે.'] })
};
// The agency has no Hindi consent wording; Hindi shows the English text rather than an unreviewed translation.
export const consentText = (l, scan) => (CONSENT_STATEMENT[l] || CONSENT_STATEMENT.en)(scan);
