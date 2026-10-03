// Staff roster: the ONE place to edit people. The username used to sign in is the employee code (a plain number such as 277).
//
// !! The codes below are PLACEHOLDERS (101, 102 ...). Replace each `code` with the person's real Stavya employee code
// !! before real use, then reseed (or update users.username for an existing database).
//
// Names and designations for the radiology department come from the Stavya organisation chart as recorded in the SSIE Radiology
// module. The chart material does not name reception, ward nurses, the administrator or the auditor, so those are role accounts.
// `base: true` marks the accounts created by the minimal seed; the rest are added with the demo traffic.
export const STAFF = {
  dr_preety:      { code: '101', name: 'Dr. Preety Ajay Krishnan', role: 'radiologist', designation: 'Radiologist · Head, Radiology', base: true },
  tech_hardik:    { code: '102', name: 'Hardik Ashokbhai Patel', role: 'technologist', designation: 'MRI Technician', base: true },
  tech_mayur:     { code: '103', name: 'Mayur Jagdishbhai Solanki', role: 'technologist', designation: 'Radiology Technologist' },
  tech_aditi:     { code: '104', name: 'Aditi Rakeshkumar Patel', role: 'technologist', designation: 'Radiology Technologist' },
  tech_bijo:      { code: '105', name: 'Bijo Rajan', role: 'technologist', designation: 'Radiology Technologist' },
  tech_tirth:     { code: '106', name: 'Tirth Sureshbhai Patel', role: 'technologist', designation: 'Radiology Technologist' },
  tech_yashkumar: { code: '107', name: 'Yashkumar Mangalbhai Parmar', role: 'technologist', designation: 'Radiology Technologist' },
  dr_mirant:      { code: '201', name: 'Dr. Mirant Bharat Dave', role: 'clinician', designation: 'Consultant Spine Surgeon', base: true },
  dr_bharat:      { code: '202', name: 'Dr. Bharat R. Dave', role: 'clinician', designation: 'Consultant Spine Surgeon', base: true },
  dr_ajay:        { code: '203', name: 'Dr. Ajay Krishnan', role: 'clinician', designation: 'Consultant Spine Surgeon' },
  dr_ravi:        { code: '204', name: 'Dr. Ravi Ranjan Rai', role: 'clinician', designation: 'Junior Spine Consultant' },
  // IPD orders are also placed by a Fellow or a Medical Officer on the consultant's behalf, not only by the named
  // consultants above -- these two carry those exact designations so the distinction shows up in real traffic.
  dr_fellow:      { code: '205', name: 'Dr. Krishna Pillai', role: 'clinician', designation: 'Fellow' },
  dr_mo:          { code: '206', name: 'Dr. Vivek Nair', role: 'clinician', designation: 'Medical Officer' },
  reception1:     { code: '301', name: 'Reception 1', role: 'reception', designation: 'Radiology Reception', base: true },
  reception2:     { code: '302', name: 'Reception 2', role: 'reception', designation: 'Radiology Reception' },
  nurse_hdu:      { code: '401', name: 'HDU Nurse', role: 'nurse', designation: 'Ward Nurse, HDU', ward: 'HDU', base: true },
  nurse_icu:      { code: '402', name: 'ICU Nurse', role: 'nurse', designation: 'Ward Nurse, ICU', ward: 'ICU' },
  nurse_wardA:    { code: '403', name: 'Ward A Nurse', role: 'nurse', designation: 'Ward Nurse, Ward A', ward: 'Ward A' },
  nurse_wardB:    { code: '404', name: 'Ward B Nurse', role: 'nurse', designation: 'Ward Nurse, Ward B', ward: 'Ward B' },
  nurse_private:  { code: '405', name: 'Private Ward Nurse', role: 'nurse', designation: 'Ward Nurse, Private', ward: 'Private' },
  admin:          { code: '901', name: 'Radiology Administrator', role: 'admin', designation: 'Radiology Administrator', base: true },
  auditor:        { code: '902', name: 'Compliance Auditor', role: 'auditor', designation: 'Compliance Auditor', base: true }
};
// alias (used in code and tests) -> employee code
export const CODE = Object.fromEntries(Object.entries(STAFF).map(([k, v]) => [k, v.code]));
