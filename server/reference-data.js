// Exam catalog and report templates. Edit these to match the hospital's real service list.
export const EXAMS = [
  // code, name, modality, body part, minutes, prep, contrast, ionising, mri, keywords
  ['XR-LS-AP-LAT', 'X-ray Lumbosacral spine AP/Lat', 'XR', 'LUMBAR_SPINE', 15, 'Remove metal objects from the area.', 0, 1, 0, 'low back pain sciatica lumbago spondylolisthesis instability listhesis scoliosis alignment'],
  ['XR-CS-AP-LAT', 'X-ray Cervical spine AP/Lat', 'XR', 'CERVICAL_SPINE', 15, 'Remove necklaces and earrings.', 0, 1, 0, 'neck pain cervical whiplash torticollis alignment'],
  ['XR-SCOLIO-FULL', 'X-ray Full spine standing (scoliosis)', 'XR', 'WHOLE_SPINE', 20, 'Wear a gown, no metal.', 0, 1, 0, 'scoliosis kyphosis deformity cobb curvature sagittal balance'],
  ['XR-KNEE', 'X-ray Knee AP/Lat', 'XR', 'KNEE', 10, '', 0, 1, 0, 'knee pain osteoarthritis fracture trauma'],
  ['XR-CHEST', 'X-ray Chest PA', 'XR', 'CHEST', 10, 'Remove upper-body metal.', 0, 1, 0, 'cough fever chest pain breathlessness pneumonia pre-op pleural effusion'],
  ['MRI-LS', 'MRI Lumbosacral spine', 'MRI', 'LUMBAR_SPINE', 35, 'No metal. Complete MRI safety checklist.', 0, 0, 1, 'radiculopathy sciatica disc prolapse herniation stenosis claudication cauda equina leg weakness numbness'],
  ['MRI-CS', 'MRI Cervical spine', 'MRI', 'CERVICAL_SPINE', 35, 'No metal. Complete MRI safety checklist.', 0, 0, 1, 'myelopathy cervical radiculopathy arm pain neck disc hand numbness cord compression'],
  ['MRI-WS', 'MRI Whole spine screening', 'MRI', 'WHOLE_SPINE', 50, 'No metal. Complete MRI safety checklist.', 0, 0, 1, 'metastasis tuberculosis infection spondylodiscitis tumour cord multiple levels'],
  ['MRI-LS-CONTRAST', 'MRI Lumbosacral spine with contrast', 'MRI', 'LUMBAR_SPINE', 45, 'eGFR needed. No metal.', 1, 0, 1, 'post-operative infection recurrent disc tumour discitis abscess enhancement'],
  ['MRI-KNEE', 'MRI Knee', 'MRI', 'KNEE', 30, 'No metal.', 0, 0, 1, 'acl meniscus ligament knee injury locking instability'],
  ['CT-LS', 'CT Lumbosacral spine', 'CT', 'LUMBAR_SPINE', 20, '', 0, 1, 0, 'fracture trauma burst implant loosening bone pre-operative planning'],
  ['CT-CS', 'CT Cervical spine', 'CT', 'CERVICAL_SPINE', 20, '', 0, 1, 0, 'fracture trauma cervical injury road accident fall'],
  ['CT-BRAIN', 'CT Brain plain', 'CT', 'BRAIN', 15, '', 0, 1, 0, 'head injury stroke headache haemorrhage bleed unconscious'],
  ['CT-ABD-CONTRAST', 'CT Abdomen/Pelvis with contrast', 'CT', 'ABDOMEN', 30, 'Fasting 4 hours. eGFR needed.', 1, 1, 0, 'abdominal pain collection abscess post-operative retroperitoneal mass'],
  ['USG-ABD', 'Ultrasound Abdomen', 'USG', 'ABDOMEN', 20, 'Fasting 6 hours, full bladder.', 0, 0, 0, 'abdominal pain gallstones liver kidney'],
  ['USG-DOPPLER-LL', 'Doppler Lower limb veins', 'USG', 'LOWER_LIMB', 30, '', 0, 0, 0, 'dvt swelling leg calf pain post-operative thrombosis'],
  ['OMRI-LS', 'Open MRI Lumbosacral spine', 'OPEN_MRI', 'LUMBAR_SPINE', 40, 'No metal. Complete MRI safety checklist. Suitable for claustrophobic patients.', 0, 0, 1, 'claustrophobia claustrophobic radiculopathy disc lumbar open mri'],
  ['OMRI-CS', 'Open MRI Cervical spine', 'OPEN_MRI', 'CERVICAL_SPINE', 40, 'No metal. Complete MRI safety checklist.', 0, 0, 1, 'claustrophobia claustrophobic cervical neck open mri'],
  ['OMRI-KNEE', 'Open MRI Knee', 'OPEN_MRI', 'KNEE', 35, 'No metal.', 0, 0, 1, 'claustrophobia knee open mri'],
  ['DEXA', 'DEXA Bone density', 'DEXA', 'SPINE_HIP', 20, 'No calcium tablets 24 hours before.', 0, 1, 0, 'osteoporosis bone density fragility fracture menopause steroid']
];

export const TEMPLATES = [
  ['tpl_mri_ls', 'MRI Lumbosacral spine', 'MRI', 'LUMBAR_SPINE',
    'Sagittal T1, T2, STIR and axial T2 sequences of the lumbosacral spine.',
    'Alignment:\nVertebral bodies:\nMarrow signal:\nConus medullaris:\nL1-2:\nL2-3:\nL3-4:\nL4-5:\nL5-S1:\nParaspinal soft tissues:',
    '1. \n2. '],
  ['tpl_mri_cs', 'MRI Cervical spine', 'MRI', 'CERVICAL_SPINE',
    'Sagittal T1, T2, STIR and axial T2/GRE sequences of the cervical spine.',
    'Alignment:\nVertebral bodies:\nCord signal and calibre:\nC2-3:\nC3-4:\nC4-5:\nC5-6:\nC6-7:\nC7-T1:\nCraniovertebral junction:',
    '1. \n2. '],
  ['tpl_xr_ls', 'X-ray Lumbosacral spine', 'XR', 'LUMBAR_SPINE',
    'AP and lateral views of the lumbosacral spine.',
    'Alignment:\nVertebral body height:\nDisc spaces:\nFacet joints:\nSacroiliac joints:\nSoft tissues:',
    '1. '],
  ['tpl_xr_scolio', 'X-ray Full spine standing', 'XR', 'WHOLE_SPINE',
    'Standing full-length AP and lateral spine.',
    'Curve pattern:\nCobb angle (apex, levels):\nRisser grade:\nCoronal balance:\nSagittal balance:\nPelvic parameters:',
    '1. '],
  ['tpl_ct_spine', 'CT Spine', 'CT', 'LUMBAR_SPINE',
    'Helical acquisition with multiplanar reformats.',
    'Alignment:\nFracture / bony lesion:\nCanal dimensions:\nDisc levels:\nImplants:\nSoft tissues:',
    '1. '],
  ['tpl_generic', 'General report', 'ANY', 'ANY', '', 'Findings:\n', '1. ']
];

// Phrases in a report that suggest an urgent result needing direct communication to the clinician.
export const CRITICAL_PATTERNS = [
  ['cauda equina', /cauda equina/i], ['cord compression', /(cord|myelopathy).{0,30}compress|compress.{0,30}cord/i],
  ['unstable fracture', /unstable.{0,20}fracture|burst fracture|fracture.{0,20}(retropulsion|instability)/i],
  ['pneumothorax', /tension pneumothorax|pneumothorax/i], ['haemorrhage', /haemorrhage|hemorrhage|intracranial bleed|epidural haematoma|subdural/i],
  ['epidural abscess', /epidural abscess|spondylodiscitis with (collection|abscess)/i],
  ['aortic emergency', /aortic (dissection|rupture)|aneurysm.{0,20}(rupture|leak)/i],
  ['pulmonary embolism', /pulmonary embol/i], ['acute DVT', /acute (dvt|deep vein thrombosis)/i],
  ['free air', /free (intraperitoneal )?air|pneumoperitoneum/i]
];

// PLACEHOLDER price list (INR). Replace with the hospital's approved tariff before real use.
export const PRICES = {
  'XR-LS-AP-LAT': 600, 'XR-CS-AP-LAT': 600, 'XR-SCOLIO-FULL': 900, 'XR-KNEE': 500, 'XR-CHEST': 400,
  'MRI-LS': 6500, 'MRI-CS': 6500, 'MRI-WS': 12000, 'MRI-LS-CONTRAST': 9000, 'MRI-KNEE': 6000,
  'OMRI-LS': 7500, 'OMRI-CS': 7500, 'OMRI-KNEE': 7000,
  'CT-LS': 4500, 'CT-CS': 4500, 'CT-BRAIN': 3000, 'CT-ABD-CONTRAST': 7000,
  'USG-ABD': 1200, 'USG-DOPPLER-LL': 1800, 'DEXA': 1800
};

// Master lists used by registration and past history. PLACEHOLDERS: replace with the hospital's own masters.
export const PROOF_TYPES = [['aadhaar', 'Aadhaar Card', 'both'], ['pan', 'PAN Card', 'front'], ['driving', 'Driving Licence', 'both'], ['voter', 'Voter ID', 'both'], ['passport', 'Passport', 'front']];
export const REFERRALS = [['self', 'Self / walk-in'], ['doctor', 'Referred by a doctor'], ['staff', 'Hospital staff'], ['web', 'Website / online'], ['family', 'Family or friend']];
export const DESIGNATIONS = ['Business owner', 'Engineer', 'Teacher', 'Clerk', 'Driver', 'Manager', 'Doctor', 'Nurse', 'Other'];
export const OCCUPATIONS = ['Student', 'House Wife', 'Job', 'Business', 'Retired', 'Worker', 'Farmer', 'Police Man', 'Army Man', 'Government Officer', 'Other'];
export const MEDICINES = [['Metformin', 'Antidiabetic'], ['Glimepiride', 'Antidiabetic'], ['Insulin', 'Antidiabetic'], ['Amlodipine', 'Antihypertensive'], ['Telmisartan', 'Antihypertensive'], ['Losartan', 'Antihypertensive'],
  ['Metoprolol', 'Antihypertensive'], ['Atorvastatin', 'Statin'], ['Rosuvastatin', 'Statin'], ['Levothyroxine', 'Thyroid'], ['Pantoprazole', 'Acid suppressant'], ['Omeprazole', 'Acid suppressant'],
  ['Paracetamol', 'Analgesic'], ['Diclofenac', 'NSAID'], ['Etoricoxib', 'NSAID'], ['Pregabalin', 'Neuropathic pain'], ['Gabapentin', 'Neuropathic pain'], ['Aspirin', 'Blood thinner'], ['Clopidogrel', 'Blood thinner'],
  ['Warfarin', 'Blood thinner'], ['Penicillin', 'Antibiotic'], ['Sulfa drugs', 'Antibiotic'], ['Ibuprofen', 'NSAID'], ['Cetirizine', 'Antihistamine']];
export const DISEASES = { Spine: ['Disc prolapse', 'Spinal stenosis', 'Scoliosis', 'Spondylolisthesis', 'Osteoporosis'], Heart: ['Coronary artery disease', 'Heart failure', 'Arrhythmia'], Lungs: ['Asthma', 'COPD', 'Tuberculosis'],
  Kidney: ['Chronic kidney disease', 'Kidney stones'], Liver: ['Fatty liver', 'Hepatitis'], Brain: ['Stroke', 'Epilepsy'] };
// Region > Level > Approach > Type > Add-on
export const SURGERY_TREE = { Cervical: { 'Single level': { Anterior: { Discectomy: ['None', 'Cage'], Fusion: ['Plate', 'Cage + plate'], 'Disc replacement': ['None'] }, Posterior: { Laminectomy: ['None'], Foraminotomy: ['None'] } }, 'Multi level': { Anterior: { Corpectomy: ['Cage + plate'] }, Posterior: { Laminoplasty: ['None'], Fusion: ['Rods + screws'] } } },
  Lumbar: { 'Single level': { Posterior: { Microdiscectomy: ['None'], Laminectomy: ['None'], TLIF: ['Cage + screws'], PLIF: ['Cage + screws'] }, Lateral: { XLIF: ['Cage'] } }, 'Multi level': { Posterior: { Decompression: ['None'], Fusion: ['Rods + screws'] } } },
  Thoracic: { 'Multi level': { Posterior: { Decompression: ['None'], Fusion: ['Rods + screws'] } } } };
