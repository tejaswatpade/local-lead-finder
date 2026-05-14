import crypto from "node:crypto";
import { config, hasSearchProvider } from "../config.js";
import { fetchJson, fetchText } from "../utils/http.js";
import {
  extractCtas,
  extractHomepageText,
  extractLinks,
  extractTitle,
  extractVisibleContact,
  findBookingPage,
  findContactPage,
} from "../utils/html.js";
import { id, nowIso } from "../utils/ids.js";
import {
  domainFromUrl,
  extractEmails,
  extractPhones,
  normalizeUrl,
  truncate,
  uniq,
} from "../utils/text.js";

const GEOCODING_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const NEARBY_SEARCH_URL = "https://places.googleapis.com/v1/places:searchNearby";
const TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

const NEARBY_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.rating",
  "places.userRatingCount",
  "places.types",
  "places.primaryType",
  "places.businessStatus",
].join(",");

const TEXT_SEARCH_FIELD_MASK = ["nextPageToken", NEARBY_FIELD_MASK].join(",");

const DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "nationalPhoneNumber",
  "internationalPhoneNumber",
  "websiteUri",
  "googleMapsUri",
  "rating",
  "userRatingCount",
  "businessStatus",
].join(",");

const TEXT_SEARCH_PAGE_SIZE = 20;
const MAX_TEXT_PAGES_PER_QUERY = 30;
const TEXT_SEARCH_PAGE_DELAY_MS = 1600;
const GOOGLE_API_TIMEOUT_MS = 10000;
const WEBSITE_SCAN_TIMEOUT_MS = 8000;
const PLACE_DETAILS_CONCURRENCY = 8;
const WEBSITE_SCAN_CONCURRENCY = 5;

function localServiceProfile({
  match,
  acceptedKeywords,
  fallbackTerms,
  requestTypes = ["service"],
  responseTypes = [],
  strictTypes = [],
  typeMap = {},
  rejectKeywords = [],
}) {
  const normalizedTypeMap = Object.fromEntries(
    Object.entries(typeMap).map(([term, types]) => [term.toLowerCase(), uniq(types)]),
  );

  return {
    match,
    acceptedKeywords: uniq(acceptedKeywords),
    fallbackTerms: uniq(fallbackTerms),
    typeMap: {
      default: uniq(requestTypes),
      ...normalizedTypeMap,
    },
    categoryKeywords: uniq([...responseTypes, ...strictTypes, ...requestTypes]),
    strictNicheTypeKeywords: uniq(strictTypes),
    rejectKeywords,
  };
}

const NICHE_PROFILES = {
  medSpa: {
    match: /med\s*spa|medical\s*spa|medi\s*spa|aesthetic|skin|botox|filler|inject|laser|facial|cosmetic clinic|beauty clinic/i,
    acceptedKeywords: [
      "med spa",
      "medispa",
      "medical spa",
      "medi spa",
      "aesthetic",
      "aesthetics",
      "aesthetics clinic",
      "skin clinic",
      "skin care",
      "laser",
      "laser clinic",
      "botox",
      "filler",
      "dermal filler",
      "cosmetic injector",
      "injectables",
      "injector",
      "facial",
      "skincare",
      "beauty clinic",
      "cosmetic clinic",
      "wellness spa",
    ],
    fallbackTerms: [
      "medical spa",
      "med spa",
      "medi spa",
      "aesthetic clinic",
      "aesthetics clinic",
      "skin clinic",
      "skin care clinic",
      "laser hair removal",
      "laser clinic",
      "botox",
      "botox clinic",
      "filler clinic",
      "injectables clinic",
      "facial spa",
      "beauty clinic",
      "cosmetic clinic",
    ],
    typeMap: {
      default: ["spa", "skin_care_clinic", "beauty_salon"],
      "medical spa": ["spa", "skin_care_clinic"],
      "aesthetic clinic": ["skin_care_clinic", "beauty_salon"],
      "aesthetics clinic": ["skin_care_clinic", "beauty_salon"],
      "skin clinic": ["skin_care_clinic"],
      "skin care clinic": ["skin_care_clinic"],
      "laser hair removal": ["laser_hair_removal_service", "skin_care_clinic"],
      "laser clinic": ["laser_hair_removal_service", "skin_care_clinic"],
      botox: ["skin_care_clinic", "doctor"],
      "botox clinic": ["skin_care_clinic", "doctor"],
      "filler clinic": ["skin_care_clinic", "doctor"],
      "injectables clinic": ["skin_care_clinic", "doctor"],
      "facial spa": ["spa", "beauty_salon"],
      "beauty clinic": ["beauty_salon", "skin_care_clinic"],
      "cosmetic clinic": ["skin_care_clinic", "doctor", "beauty_salon"],
    },
    categoryKeywords: [
      "spa",
      "beauty_salon",
      "skin_care_clinic",
      "laser_hair_removal_service",
      "medical_spa",
    ],
    strictNicheTypeKeywords: ["skin_care_clinic", "laser_hair_removal_service", "medical_spa"],
    rejectKeywords: ["hotel", "resort", "academy", "training"],
  },
  spa: {
    match: /^(spa|day spa|beauty spa|wellness spa|head spa|massage|massage therapist|massage spa)$/i,
    acceptedKeywords: [
      "spa",
      "day spa",
      "beauty spa",
      "wellness spa",
      "head spa",
      "massage",
      "facial",
      "skincare",
      "skin care",
      "beauty salon",
      "skin clinic",
    ],
    fallbackTerms: [
      "day spa",
      "beauty spa",
      "wellness spa",
      "head spa",
      "facial spa",
      "massage spa",
      "skin care clinic",
      "beauty salon",
    ],
    typeMap: {
      default: ["spa", "beauty_salon", "massage"],
      "day spa": ["spa", "massage"],
      "beauty spa": ["spa", "beauty_salon"],
      "wellness spa": ["spa"],
      "head spa": ["spa"],
      "facial spa": ["spa", "beauty_salon"],
      "massage spa": ["spa", "massage"],
      "skin care clinic": ["skin_care_clinic"],
      "beauty salon": ["beauty_salon"],
    },
    categoryKeywords: ["spa", "beauty_salon", "massage", "skin_care_clinic"],
    strictNicheTypeKeywords: ["spa", "beauty_salon", "massage", "skin_care_clinic"],
    rejectKeywords: [
      "school",
      "college",
      "university",
      "hotel",
      "resort",
      "academy",
      "training",
      "pharmacy",
      "chemist",
      "superdrug",
      "boots",
      "store",
      "shop",
      "retail",
    ],
  },
  roofers: {
    match: /roof|roofer|gutter|siding|storm damage/i,
    acceptedKeywords: [
      "roofer",
      "roofing",
      "roof repair",
      "roofing contractor",
      "roof replacement",
      "gutter",
      "siding",
      "storm damage",
    ],
    fallbackTerms: [
      "roofing contractor",
      "roof repair",
      "roof replacement",
      "gutter repair",
      "storm damage roofing",
    ],
    typeMap: {
      default: ["roofing_contractor"],
      "roofing contractor": ["roofing_contractor"],
      "roof repair": ["roofing_contractor"],
      "roof replacement": ["roofing_contractor"],
      "gutter repair": ["roofing_contractor"],
      "storm damage roofing": ["roofing_contractor"],
    },
    categoryKeywords: ["roofing_contractor", "contractor"],
    strictNicheTypeKeywords: ["roofing_contractor"],
  },
  landscapers: {
    match: /landscap|landscape gardener|garden design|gardener|gardening|lawn|grounds maintenance|turf/i,
    acceptedKeywords: [
      "landscaper",
      "landscapers",
      "landscaping",
      "landscape",
      "landscape gardener",
      "garden design",
      "gardener",
      "gardening",
      "lawn care",
      "grounds maintenance",
      "groundskeeping",
      "paving",
      "patio",
      "fencing",
      "turf",
      "tree surgery",
      "outdoor maintenance",
    ],
    fallbackTerms: [
      "landscape gardener",
      "landscaping company",
      "garden design",
      "gardener",
      "lawn care",
      "grounds maintenance",
      "paving contractor",
      "fencing contractor",
      "patio installer",
      "turf installation",
    ],
    typeMap: {
      default: ["service"],
      "landscape gardener": ["service"],
      "landscaping company": ["service"],
      "garden design": ["service"],
      gardener: ["service"],
      "lawn care": ["service"],
      "grounds maintenance": ["service"],
      "paving contractor": ["service"],
      "fencing contractor": ["service"],
      "patio installer": ["service"],
      "turf installation": ["service"],
    },
    categoryKeywords: [
      "landscaper",
      "gardener",
      "landscape_architect",
      "paving_contractor",
      "fence_contractor",
      "contractor",
    ],
    strictNicheTypeKeywords: [
      "landscaper",
      "gardener",
      "landscape_architect",
      "paving_contractor",
      "fence_contractor",
    ],
    rejectKeywords: ["school", "college", "university", "job", "course", "directory", "article"],
  },
  dentists: {
    match: /dentist|dental|orthodont/i,
    acceptedKeywords: [
      "dentist",
      "dental",
      "orthodontist",
      "dental clinic",
      "cosmetic dentist",
      "family dentistry",
      "emergency dentist",
    ],
    fallbackTerms: [
      "dental clinic",
      "cosmetic dentist",
      "family dentist",
      "emergency dentist",
      "orthodontist",
    ],
    typeMap: {
      default: ["dentist", "dental_clinic"],
      "dental clinic": ["dental_clinic", "dentist"],
      "cosmetic dentist": ["dentist", "dental_clinic"],
      "family dentist": ["dentist"],
      "emergency dentist": ["dentist"],
      orthodontist: ["dentist"],
    },
    categoryKeywords: ["dentist", "dental_clinic"],
    strictNicheTypeKeywords: ["dentist", "dental_clinic"],
  },
  plumbers: localServiceProfile({
    match: /plumb|drain|pipe leak|leak repair|water heater|boiler repair/i,
    acceptedKeywords: [
      "plumber",
      "plumbing",
      "drain cleaning",
      "drain repair",
      "pipe repair",
      "leak repair",
      "water heater",
      "boiler repair",
      "emergency plumber",
      "bathroom plumbing",
    ],
    fallbackTerms: [
      "plumber",
      "plumbing company",
      "emergency plumber",
      "drain cleaning",
      "drain repair",
      "leak repair",
      "water heater repair",
      "boiler repair",
    ],
    requestTypes: ["plumber"],
    strictTypes: ["plumber"],
    responseTypes: ["plumbing_service"],
  }),
  electricians: localServiceProfile({
    match: /electric|electrician|ev charger|rewire|lighting install|sparky/i,
    acceptedKeywords: [
      "electrician",
      "electrical",
      "electrical contractor",
      "ev charger",
      "rewire",
      "lighting installation",
      "emergency electrician",
      "consumer unit",
      "fuse box",
    ],
    fallbackTerms: [
      "electrician",
      "electrical contractor",
      "emergency electrician",
      "ev charger installer",
      "house rewiring",
      "lighting installation",
    ],
    requestTypes: ["electrician"],
    strictTypes: ["electrician"],
  }),
  hvac: localServiceProfile({
    match: /hvac|air conditioning|ac repair|heating|boiler|furnace|heat pump|ventilation/i,
    acceptedKeywords: [
      "hvac",
      "air conditioning",
      "ac repair",
      "heating",
      "heating contractor",
      "boiler",
      "furnace",
      "heat pump",
      "ventilation",
      "cooling",
    ],
    fallbackTerms: [
      "hvac contractor",
      "air conditioning repair",
      "air conditioning installation",
      "heating contractor",
      "boiler repair",
      "furnace repair",
      "heat pump installer",
    ],
    requestTypes: ["service"],
    strictTypes: ["hvac_contractor", "air_conditioning_contractor", "heating_contractor"],
  }),
  pestControl: localServiceProfile({
    match: /pest|exterminator|termite|bed bug|rodent|rat control|wasp/i,
    acceptedKeywords: [
      "pest control",
      "exterminator",
      "termite",
      "bed bug",
      "rodent",
      "rat control",
      "wasp control",
      "insect control",
    ],
    fallbackTerms: [
      "pest control",
      "exterminator",
      "termite control",
      "bed bug treatment",
      "rodent control",
      "wasp control",
    ],
    requestTypes: ["service"],
    strictTypes: ["pest_control_service"],
  }),
  cleaners: localServiceProfile({
    match: /cleaner|cleaning|maid|janitorial|carpet clean|window clean|pressure wash|power wash/i,
    acceptedKeywords: [
      "cleaner",
      "cleaning",
      "cleaning service",
      "house cleaning",
      "office cleaning",
      "commercial cleaning",
      "maid service",
      "janitorial",
      "carpet cleaning",
      "window cleaning",
      "pressure washing",
      "power washing",
    ],
    fallbackTerms: [
      "cleaning service",
      "house cleaning",
      "office cleaning",
      "commercial cleaning",
      "maid service",
      "janitorial service",
      "carpet cleaning",
      "window cleaning",
      "pressure washing",
    ],
    requestTypes: ["service", "laundry"],
    strictTypes: ["cleaning_service", "house_cleaning_service", "laundry"],
  }),
  painters: localServiceProfile({
    match: /painter|painting|decorator|paint contractor/i,
    acceptedKeywords: [
      "painter",
      "painting",
      "painting contractor",
      "decorator",
      "interior painting",
      "exterior painting",
      "house painter",
    ],
    fallbackTerms: [
      "painting contractor",
      "house painter",
      "interior painting",
      "exterior painting",
      "painter decorator",
    ],
    requestTypes: ["painter"],
    strictTypes: ["painter"],
  }),
  remodelers: localServiceProfile({
    match: /remodel|renovation|builder|contractor|home improvement|kitchen fitter|bathroom fitter/i,
    acceptedKeywords: [
      "remodeler",
      "remodelling",
      "remodeling",
      "renovation",
      "home improvement",
      "builder",
      "building contractor",
      "general contractor",
      "kitchen fitter",
      "bathroom fitter",
      "construction",
    ],
    fallbackTerms: [
      "home renovation contractor",
      "remodeling contractor",
      "home improvement contractor",
      "general contractor",
      "builder",
      "kitchen fitter",
      "bathroom fitter",
    ],
    requestTypes: ["service", "home_improvement_store"],
    strictTypes: ["general_contractor", "contractor", "home_builder", "construction_company", "remodeler"],
  }),
  flooring: localServiceProfile({
    match: /floor|flooring|carpet installer|tile installer|hardwood/i,
    acceptedKeywords: [
      "flooring",
      "floor installer",
      "flooring contractor",
      "carpet installer",
      "tile installer",
      "hardwood floor",
      "vinyl flooring",
      "laminate flooring",
    ],
    fallbackTerms: [
      "flooring contractor",
      "floor installer",
      "carpet installer",
      "tile installer",
      "hardwood flooring",
      "vinyl flooring",
    ],
    requestTypes: ["home_improvement_store", "building_materials_store", "service"],
    strictTypes: ["flooring_contractor", "flooring_store"],
  }),
  pavers: localServiceProfile({
    match: /paving|driveway|patio installer|asphalt|concrete contractor|block paving/i,
    acceptedKeywords: [
      "paving",
      "paving contractor",
      "driveway",
      "driveway installer",
      "patio installer",
      "asphalt",
      "concrete contractor",
      "block paving",
      "resin driveway",
    ],
    fallbackTerms: [
      "paving contractor",
      "driveway installer",
      "patio installer",
      "block paving",
      "resin driveway",
      "asphalt contractor",
      "concrete contractor",
    ],
    requestTypes: ["service", "building_materials_store"],
    strictTypes: ["paving_contractor", "asphalt_contractor", "concrete_contractor"],
  }),
  fencing: localServiceProfile({
    match: /fenc|fence contractor|decking|gate installer/i,
    acceptedKeywords: [
      "fence",
      "fencing",
      "fence contractor",
      "fence installer",
      "gate installer",
      "decking",
      "deck builder",
    ],
    fallbackTerms: [
      "fence contractor",
      "fence installer",
      "fencing company",
      "gate installer",
      "deck builder",
      "decking installer",
    ],
    requestTypes: ["service", "home_improvement_store"],
    strictTypes: ["fence_contractor", "deck_builder"],
  }),
  treeServices: localServiceProfile({
    match: /tree service|tree surgeon|arborist|tree removal|stump grinding|hedge trimming/i,
    acceptedKeywords: [
      "tree service",
      "tree surgeon",
      "arborist",
      "tree removal",
      "stump grinding",
      "tree trimming",
      "hedge trimming",
    ],
    fallbackTerms: [
      "tree service",
      "tree surgeon",
      "arborist",
      "tree removal",
      "stump grinding",
      "tree trimming",
    ],
    requestTypes: ["service"],
    strictTypes: ["tree_service", "arborist"],
  }),
  salons: localServiceProfile({
    match: /hair salon|beauty salon|salon|hairdresser|makeup|lashes|eyebrow/i,
    acceptedKeywords: [
      "salon",
      "hair salon",
      "beauty salon",
      "hairdresser",
      "makeup",
      "lashes",
      "eyebrow",
      "brow bar",
    ],
    fallbackTerms: [
      "hair salon",
      "beauty salon",
      "hairdresser",
      "makeup artist",
      "lash salon",
      "eyebrow salon",
    ],
    requestTypes: ["beauty_salon", "hair_salon", "hair_care"],
    strictTypes: ["beauty_salon", "hair_salon", "hair_care", "makeup_artist"],
  }),
  barbers: localServiceProfile({
    match: /barber|barbershop|men.?s hair/i,
    acceptedKeywords: ["barber", "barbershop", "barber shop", "men's hair", "mens hair"],
    fallbackTerms: ["barber shop", "barbershop", "men's hair salon"],
    requestTypes: ["barber_shop", "hair_care"],
    strictTypes: ["barber_shop", "hair_care"],
  }),
  nailSalons: localServiceProfile({
    match: /nail|manicure|pedicure/i,
    acceptedKeywords: ["nail salon", "nails", "manicure", "pedicure", "gel nails", "acrylic nails"],
    fallbackTerms: ["nail salon", "manicure", "pedicure", "gel nails", "acrylic nails"],
    requestTypes: ["nail_salon", "beauty_salon"],
    strictTypes: ["nail_salon", "beauty_salon"],
  }),
  gyms: localServiceProfile({
    match: /gym|fitness|personal trainer|yoga|pilates|crossfit|boxing gym/i,
    acceptedKeywords: [
      "gym",
      "fitness",
      "fitness center",
      "personal trainer",
      "yoga",
      "pilates",
      "crossfit",
      "boxing gym",
    ],
    fallbackTerms: [
      "gym",
      "fitness center",
      "personal trainer",
      "yoga studio",
      "pilates studio",
      "boxing gym",
    ],
    requestTypes: ["gym", "fitness_center", "sports_coaching", "yoga_studio"],
    strictTypes: ["gym", "fitness_center", "sports_coaching", "yoga_studio"],
  }),
  chiropractors: localServiceProfile({
    match: /chiropractor|chiropractic|back pain clinic/i,
    acceptedKeywords: ["chiropractor", "chiropractic", "back pain clinic", "spine clinic"],
    fallbackTerms: ["chiropractor", "chiropractic clinic", "back pain clinic", "spine clinic"],
    requestTypes: ["chiropractor"],
    strictTypes: ["chiropractor"],
  }),
  physiotherapy: localServiceProfile({
    match: /physio|physiotherapy|physical therapy|sports therapy|rehab clinic/i,
    acceptedKeywords: [
      "physio",
      "physiotherapy",
      "physical therapy",
      "sports therapy",
      "rehab clinic",
      "rehabilitation",
    ],
    fallbackTerms: [
      "physiotherapy clinic",
      "physical therapy clinic",
      "sports therapy",
      "rehab clinic",
      "rehabilitation clinic",
    ],
    requestTypes: ["physiotherapist", "medical_clinic"],
    strictTypes: ["physiotherapist", "medical_clinic"],
  }),
  vets: localServiceProfile({
    match: /vet|veterinary|animal clinic|animal hospital/i,
    acceptedKeywords: ["vet", "veterinary", "veterinary clinic", "animal clinic", "animal hospital"],
    fallbackTerms: ["veterinary clinic", "vet clinic", "animal clinic", "animal hospital"],
    requestTypes: ["veterinary_care", "pet_care"],
    strictTypes: ["veterinary_care", "pet_care"],
    rejectKeywords: ["pet supplies online"],
  }),
  petGroomers: localServiceProfile({
    match: /pet groom|dog groom|cat groom|dog wash|dog salon|pet salon|pet stylist|dog stylist|animal groom|grooming salon/i,
    acceptedKeywords: [
      "pet groomer",
      "pet grooming",
      "pet salon",
      "dog salon",
      "dog groomer",
      "dog grooming",
      "dog grooming salon",
      "cat grooming",
      "dog wash",
      "pet stylist",
      "dog stylist",
      "animal grooming",
    ],
    fallbackTerms: [
      "pet groomer",
      "dog groomer",
      "pet grooming",
      "dog grooming",
      "dog salon",
      "pet salon",
      "dog grooming salon",
      "pet grooming salon",
      "dog wash",
    ],
    requestTypes: ["pet_store"],
    responseTypes: ["pet_store"],
    strictTypes: ["pet_groomer", "pet_care"],
    rejectKeywords: [
      "hair salon",
      "beauty salon",
      "nail salon",
      "barber",
      "barbershop",
      "makeup",
      "lashes",
      "eyebrow",
      "brow bar",
      "spa",
    ],
  }),
  lawyers: localServiceProfile({
    match: /lawyer|attorney|law firm|solicitor|legal/i,
    acceptedKeywords: ["lawyer", "attorney", "law firm", "solicitor", "legal services"],
    fallbackTerms: ["law firm", "lawyer", "attorney", "solicitor", "legal services"],
    requestTypes: ["lawyer"],
    strictTypes: ["lawyer"],
  }),
  accountants: localServiceProfile({
    match: /accountant|accounting|bookkeep|tax prepar|cpa/i,
    acceptedKeywords: ["accountant", "accounting", "bookkeeper", "bookkeeping", "tax preparation", "cpa"],
    fallbackTerms: ["accountant", "accounting firm", "bookkeeper", "bookkeeping service", "tax preparation"],
    requestTypes: ["accounting", "consultant"],
    strictTypes: ["accounting"],
  }),
  realEstateAgents: localServiceProfile({
    match: /real estate|realtor|estate agent|letting agent|property agent/i,
    acceptedKeywords: ["real estate", "realtor", "estate agent", "letting agent", "property agent", "real estate agency"],
    fallbackTerms: ["real estate agent", "realtor", "estate agent", "letting agent", "property agent"],
    requestTypes: ["real_estate_agency"],
    strictTypes: ["real_estate_agency"],
  }),
  insuranceAgents: localServiceProfile({
    match: /insurance|insurance agent|broker/i,
    acceptedKeywords: ["insurance", "insurance agent", "insurance agency", "insurance broker"],
    fallbackTerms: ["insurance agency", "insurance agent", "insurance broker"],
    requestTypes: ["insurance_agency"],
    strictTypes: ["insurance_agency"],
  }),
  photographers: localServiceProfile({
    match: /photographer|photography|photo studio|wedding photo|portrait/i,
    acceptedKeywords: ["photographer", "photography", "photo studio", "wedding photographer", "portrait photographer"],
    fallbackTerms: ["photographer", "photography studio", "wedding photographer", "portrait photographer"],
    requestTypes: ["service"],
    strictTypes: ["photographer", "photography_studio"],
  }),
  autoRepair: localServiceProfile({
    match: /auto repair|car repair|mechanic|garage|mot test|oil change|brake repair|tyre|tire/i,
    acceptedKeywords: [
      "auto repair",
      "car repair",
      "mechanic",
      "garage",
      "mot",
      "oil change",
      "brake repair",
      "tire",
      "tyre",
    ],
    fallbackTerms: [
      "auto repair shop",
      "car repair",
      "mechanic",
      "garage",
      "mot test",
      "brake repair",
      "oil change",
    ],
    requestTypes: ["car_repair", "auto_parts_store"],
    strictTypes: ["car_repair", "auto_repair_shop"],
  }),
  carDetailing: localServiceProfile({
    match: /car detail|auto detail|mobile valeting|car valet|car wash/i,
    acceptedKeywords: ["car detailing", "auto detailing", "mobile valeting", "car valet", "car wash"],
    fallbackTerms: ["car detailing", "auto detailing", "mobile valeting", "car valet", "car wash"],
    requestTypes: ["car_wash", "car_repair"],
    strictTypes: ["car_wash", "auto_detailing"],
  }),
  movers: localServiceProfile({
    match: /mover|moving company|removal company|removals|man and van/i,
    acceptedKeywords: ["mover", "moving company", "removal company", "removals", "man and van"],
    fallbackTerms: ["moving company", "movers", "removal company", "removals", "man and van"],
    requestTypes: ["moving_company"],
    strictTypes: ["moving_company"],
  }),
  locksmiths: localServiceProfile({
    match: /locksmith|lock repair|key cutting|emergency lock/i,
    acceptedKeywords: ["locksmith", "lock repair", "key cutting", "emergency locksmith", "lockout"],
    fallbackTerms: ["locksmith", "emergency locksmith", "lock repair", "key cutting"],
    requestTypes: ["locksmith"],
    strictTypes: ["locksmith"],
  }),
  restaurants: localServiceProfile({
    match: /restaurant|diner|bistro|grill|steakhouse|pizza|sushi|takeaway|takeout/i,
    acceptedKeywords: ["restaurant", "diner", "bistro", "grill", "steakhouse", "pizza", "sushi", "takeaway", "takeout"],
    fallbackTerms: ["restaurant", "diner", "bistro", "grill", "pizza restaurant", "sushi restaurant", "takeaway"],
    requestTypes: ["restaurant"],
    strictTypes: ["restaurant"],
    rejectKeywords: ["recipe", "food blog"],
  }),
  cafes: localServiceProfile({
    match: /cafe|coffee|coffee shop|tea room|bakery cafe/i,
    acceptedKeywords: ["cafe", "coffee", "coffee shop", "tea room", "bakery cafe"],
    fallbackTerms: ["cafe", "coffee shop", "tea room", "bakery cafe"],
    requestTypes: ["cafe", "coffee_shop"],
    strictTypes: ["cafe", "coffee_shop"],
  }),
  bakeries: localServiceProfile({
    match: /bakery|baker|cake shop|cupcake|pastry/i,
    acceptedKeywords: ["bakery", "baker", "cake shop", "cupcake", "pastry"],
    fallbackTerms: ["bakery", "cake shop", "cupcake bakery", "pastry shop"],
    requestTypes: ["bakery"],
    strictTypes: ["bakery"],
  }),
  florists: localServiceProfile({
    match: /florist|flower shop|flowers/i,
    acceptedKeywords: ["florist", "flower shop", "flowers", "wedding flowers"],
    fallbackTerms: ["florist", "flower shop", "wedding flowers"],
    requestTypes: ["florist"],
    strictTypes: ["florist"],
  }),
  childcare: localServiceProfile({
    match: /childcare|child care|daycare|nursery|preschool/i,
    acceptedKeywords: ["childcare", "child care", "daycare", "nursery", "preschool"],
    fallbackTerms: ["childcare", "child care center", "daycare", "nursery", "preschool"],
    requestTypes: ["child_care_agency", "preschool"],
    strictTypes: ["child_care_agency", "preschool"],
  }),
  marketingAgencies: localServiceProfile({
    match: /marketing agency|digital marketing|seo|social media agency|ppc|advertising agency/i,
    acceptedKeywords: [
      "marketing agency",
      "digital marketing",
      "seo",
      "social media agency",
      "ppc",
      "advertising agency",
    ],
    fallbackTerms: [
      "marketing agency",
      "digital marketing agency",
      "seo agency",
      "social media agency",
      "ppc agency",
      "advertising agency",
    ],
    requestTypes: ["marketing_consultant", "consultant", "service"],
    strictTypes: ["marketing_consultant", "advertising_agency"],
  }),
  webDesigners: localServiceProfile({
    match: /web design|website design|web developer|website developer|web agency/i,
    acceptedKeywords: ["web design", "website design", "web developer", "website developer", "web agency"],
    fallbackTerms: ["web design agency", "website designer", "web developer", "website developer", "web agency"],
    requestTypes: ["consultant", "service"],
    strictTypes: ["web_designer", "website_designer", "marketing_consultant"],
  }),
};

const PROFILE_MATCH_PRIORITY = [
  "petGroomers",
  "nailSalons",
  "barbers",
  "medSpa",
  "spa",
];

const REJECT_KEYWORDS = [
  "school",
  "university",
  "college",
  "hospital",
  "museum",
  "history",
  "blog",
  "article",
  "news",
  "directory",
  "wikipedia",
  "research",
  "institute",
  "job",
  "course",
];

const DIRECTORY_DOMAINS = [
  "yelp.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "wikipedia.org",
  "tripadvisor.com",
  "mapquest.com",
  "yellowpages.com",
  "healthgrades.com",
  "zocdoc.com",
  "webmd.com",
  "google.com",
  "maps.google.com",
];

export async function runLeadDiscoveryAgent(input, context) {
  const {
    niche,
    location,
    locationLat,
    locationLng,
    leadCount,
    radiusKm = 15,
    reviewFilterEnabled = false,
    minReviews = 0,
    maxReviews = 1000000,
    searchDepth = "smart",
    websiteFilter = "any",
    visibilityFilter = "any",
    opportunityFilter = "any",
    notes = "",
  } = input;
  const {
    storage,
    log,
    runId,
    updateRun,
    onProgress,
    contactPreference = "any",
    shouldStop = async () => false,
  } = context;

  if (!hasSearchProvider() || !config.search.googleGeocodingApiKey) {
    throw new Error(
      "Google Places/Geocoding discovery is not configured. Add GOOGLE_PLACES_API_KEY and enable Geocoding API.",
    );
  }

  const debug = emptyDebug();
  const metrics = emptyMetrics(context.trackUsage);
  const profile = nicheProfile(niche);
  const filters = normalizeDiscoveryFilters({
    searchDepth,
    websiteFilter,
    visibilityFilter,
    opportunityFilter,
  });
  const radiusMeters = Math.round(Number(radiusKm) * 1000);
  const hasPinnedLocation = Number.isFinite(Number(locationLat)) && Number.isFinite(Number(locationLng));
  await updateRun?.(runId, {
    currentStep: "Searching places",
    progressDone: 0,
    progressTotal: leadCount,
  });
  const geocoded = hasPinnedLocation
    ? { lat: Number(locationLat), lng: Number(locationLng) }
    : await cachedGeocodeLocation(location, { storage, metrics });
  const searchPoints = gridPoints(geocoded, radiusMeters, leadCount, filters.searchDepth);
  const plans = searchPlans(niche, profile, filters.searchDepth);
  const existing = await storage.list("Leads");
  const seen = buildExistingDedupe(existing);
  const leads = [];
  const strictRange = normalizeReviewRange(minReviews, maxReviews, reviewFilterEnabled);
  const websiteLimiter = createLimiter(WEBSITE_SCAN_CONCURRENCY);
  const searchCacheKey = buildSearchCacheKey({
    niche,
    location,
    locationLat: hasPinnedLocation ? geocoded.lat : "",
    locationLng: hasPinnedLocation ? geocoded.lng : "",
    radiusKm,
    reviewFilterEnabled: strictRange.enabled,
    minReviews: strictRange.minReviews,
    maxReviews: strictRange.maxReviews,
    searchDepth: filters.searchDepth,
    websiteFilter: filters.websiteFilter,
    visibilityFilter: filters.visibilityFilter,
    opportunityFilter: filters.opportunityFilter,
  });
  const cachedRawPlaces = await cachedSearchResults(searchCacheKey, { storage, metrics });
  const rawPlacesForCache = [];

  await log(
    "Lead Discovery Agent",
    "info",
    `${hasPinnedLocation ? "Using map pin" : `Geocoded ${location}`} at ${geocoded.lat},${geocoded.lng}. Searching ${radiusKm}km with ${filters.searchDepth} depth across ${searchPoints.length} grid point${searchPoints.length === 1 ? "" : "s"}${strictRange.enabled ? ` and review range ${strictRange.minReviews}-${strictRange.maxReviews}` : " with review filter off"}.`,
  );
  await log(
    "Lead Discovery Agent",
    "info",
    `Loaded ${existing.length} saved leads for dedupe. Matching Place IDs, business/address pairs, domains, and phone numbers will be skipped before repeat enrichment.`,
  );

  await log(
    "Lead Discovery Agent",
    "info",
    "Using Google Places Text Search first, then Nearby Search only if more leads are needed.",
  );

  if (cachedRawPlaces.length) {
    if (await shouldStop()) return stopDiscoveryEarly({ leads, leadCount, updateRun, runId, debug, log });
    await updateRun?.(runId, {
      currentStep: "Filtering leads",
      progressDone: 0,
      progressTotal: leadCount,
    });
    debug.rawPlacesFound += cachedRawPlaces.length;
    await updateDiscoveryDebug(updateRun, runId, debug, leadCount);
    await log(
      "Lead Discovery Agent",
      "info",
      `Loaded ${cachedRawPlaces.length} cached raw places for this search before calling Google.`,
    );
    await processCandidatePlaces(cachedRawPlaces, {
      niche,
      location,
      leadCount,
      notes,
      profile,
      reviewRange: strictRange,
      contactPreference,
      seen,
      leads,
      debug,
      filters,
      metrics,
      storage,
      log,
      runId,
      updateRun,
      websiteLimiter,
      shouldStop,
    });
  }

  for (const point of searchPoints) {
    if (await shouldStop()) return stopDiscoveryEarly({ leads, leadCount, updateRun, runId, debug, log });
    if (leads.length >= leadCount) break;

    for (const plan of plans) {
      if (await shouldStop()) return stopDiscoveryEarly({ leads, leadCount, updateRun, runId, debug, log });
      if (leads.length >= leadCount) break;

      try {
        let pageNumber = 0;
        for await (const rawPlaces of textSearchPages({
          textQuery: `${plan.term} in ${location}`,
          center: point,
          radiusMeters: point.radiusMeters,
          maxPages: textPageLimit(leadCount, leads.length, filters.searchDepth),
          searchDepth: filters.searchDepth,
          metrics,
        })) {
          if (await shouldStop()) return stopDiscoveryEarly({ leads, leadCount, updateRun, runId, debug, log });
          pageNumber += 1;
          const annotatedPlaces = annotateRawPlaces(rawPlaces, {
            point,
            plan,
            pageNumber,
            source: "text",
          });
          debug.rawPlacesFound += annotatedPlaces.length;
          rawPlacesForCache.push(...annotatedPlaces);
          await updateDiscoveryDebug(updateRun, runId, debug, leadCount);
          await log(
            "Lead Discovery Agent",
            "info",
            `Google Text Search ${point.label} / ${plan.term} page ${pageNumber} returned ${annotatedPlaces.length} raw places.`,
          );

          await processCandidatePlaces(annotatedPlaces, {
            niche,
            location,
            leadCount,
            notes,
            profile,
            reviewRange: strictRange,
            contactPreference,
            seen,
            leads,
            debug,
            filters,
            metrics,
            storage,
            log,
            runId,
            updateRun,
            websiteLimiter,
            shouldStop,
          });

          if (leads.length >= leadCount) break;
        }
      } catch (error) {
        await log(
          "Lead Discovery Agent",
          "warn",
          `Google Text Search failed for ${plan.term}: ${truncate(error.message, 220)}.`,
        );
        continue;
      }
    }
  }

  if (leads.length < leadCount && filters.searchDepth !== "fast") {
    await log(
      "Lead Discovery Agent",
      "info",
      `Text Search found ${leads.length}/${leadCount}. Running Nearby Search fallback.`,
    );

    for (const point of searchPoints) {
      if (await shouldStop()) return stopDiscoveryEarly({ leads, leadCount, updateRun, runId, debug, log });
      if (leads.length >= leadCount) break;

      for (const plan of plans) {
        if (await shouldStop()) return stopDiscoveryEarly({ leads, leadCount, updateRun, runId, debug, log });
        if (leads.length >= leadCount) break;

        for (const includedType of plan.types) {
          if (await shouldStop()) return stopDiscoveryEarly({ leads, leadCount, updateRun, runId, debug, log });
          if (leads.length >= leadCount) break;

          let rawPlaces = [];
          try {
            rawPlaces = await nearbySearch({
              center: point,
              radiusMeters: point.radiusMeters,
              includedType,
              metrics,
            });
          } catch (error) {
            await log(
              "Lead Discovery Agent",
              "warn",
              `Google Nearby Search failed for ${plan.term}/${includedType}: ${truncate(error.message, 220)}.`,
            );
            continue;
          }

          const annotatedPlaces = annotateRawPlaces(rawPlaces, {
            point,
            plan,
            pageNumber: 1,
            source: "nearby",
          });
          debug.rawPlacesFound += annotatedPlaces.length;
          rawPlacesForCache.push(...annotatedPlaces);
          await updateDiscoveryDebug(updateRun, runId, debug, leadCount);
          await log(
            "Lead Discovery Agent",
            "info",
            `Google Nearby Search ${point.label} / ${plan.term} / ${includedType} returned ${annotatedPlaces.length} raw places.`,
          );

          await processCandidatePlaces(annotatedPlaces, {
            niche,
            location,
            leadCount,
            notes,
            profile,
            reviewRange: strictRange,
            contactPreference,
            seen,
            leads,
            debug,
            filters,
            metrics,
            storage,
            log,
            runId,
            updateRun,
            websiteLimiter,
            shouldStop,
          });
        }
      }
    }
  }

  const message =
    leads.length < leadCount
      ? `Found ${leads.length} qualified leads after filtering irrelevant results.`
      : `Found ${leads.length} qualified leads.`;

  await updateDiscoveryDebug(updateRun, runId, debug, leadCount, message);
  if (rawPlacesForCache.length) {
    await saveSearchResultsCache(storage, searchCacheKey, {
      niche,
      location,
      radiusKm,
      reviewFilterEnabled: strictRange.enabled,
      minReviews: strictRange.minReviews,
      maxReviews: strictRange.maxReviews,
      searchDepth: filters.searchDepth,
      websiteFilter: filters.websiteFilter,
      visibilityFilter: filters.visibilityFilter,
      opportunityFilter: filters.opportunityFilter,
      rawPlaces: rawPlacesForCache,
    });
  }
  await log("Lead Discovery Agent", "info", message);
  await log("Lead Discovery Agent", "info", formatMetrics(metrics));

  return leads;
}

function annotateRawPlaces(rawPlaces, { point, plan, pageNumber, source }) {
  return (rawPlaces || []).map((place, index) => ({
    ...place,
    __searchMeta: {
      source,
      pointLabel: point?.label || "center",
      searchTerm: plan?.term || "",
      pageNumber,
      rank: (Math.max(1, Number(pageNumber) || 1) - 1) * TEXT_SEARCH_PAGE_SIZE + index + 1,
    },
  }));
}

async function stopDiscoveryEarly({ leads, leadCount, updateRun, runId, debug, log }) {
  const message = `Search stopped by user at ${leads.length}/${leadCount} qualified leads.`;
  await updateDiscoveryDebug(updateRun, runId, debug, leadCount, message);
  await log?.("Lead Discovery Agent", "warn", message);
  return leads;
}

async function isDiscoveryStopRequested(options) {
  if (typeof options.shouldStop !== "function") return false;
  try {
    return Boolean(await options.shouldStop());
  } catch {
    return false;
  }
}

async function processCandidatePlaces(rawPlaces, options) {
  if (await isDiscoveryStopRequested(options)) return;
  await options.updateRun?.(options.runId, {
    currentStep: "Filtering leads",
    progressDone: options.leads.length,
    progressTotal: options.leadCount,
  });
  const candidates = [];

  for (const place of rawPlaces) {
    if (await isDiscoveryStopRequested(options)) break;
    if (options.leads.length >= options.leadCount) break;

    const basic = normalizeNearbyPlace(place, options.niche, options.location);
    const precheck = precheckPlace(basic, options.profile, options.reviewRange, options.filters);
    if (!precheck.accepted) {
      incrementRejection(options.debug, precheck.reason);
      continue;
    }

    if (hasDuplicate(options.seen, basic)) {
      options.debug.removedAsDuplicate += 1;
      options.debug.duplicatesRemoved += 1;
      continue;
    }

    addDedupeKeys(options.seen, basic);
    candidates.push({ basic, precheck });
    if (candidates.length >= Math.max(PLACE_DETAILS_CONCURRENCY, options.leadCount - options.leads.length + PLACE_DETAILS_CONCURRENCY)) {
      break;
    }
  }

  if (!candidates.length || (await isDiscoveryStopRequested(options))) return;

  await options.updateRun?.(options.runId, {
    currentStep: "Enriching contacts",
    progressDone: options.leads.length,
    progressTotal: options.leadCount,
  });
  await mapConcurrent(candidates, PLACE_DETAILS_CONCURRENCY, ({ basic, precheck }) =>
    processAcceptedCandidate(basic, {
      ...options,
      precheck,
      countRejections: false,
    }),
  );
}

async function processAcceptedCandidate(basic, options) {
  const {
    niche,
    location,
    leadCount,
    notes,
    profile,
    reviewRange,
    seen,
    leads,
    debug,
    metrics,
    storage,
    log,
    runId,
    updateRun,
    websiteLimiter,
    contactPreference,
    precheck: existingPrecheck,
    countRejections = true,
  } = options;

  if (await isDiscoveryStopRequested(options)) return "stopped";
  if (leads.length >= leadCount) return "full";

  const precheck = existingPrecheck || precheckPlace(basic, profile, reviewRange, options.filters);
  if (!precheck.accepted) {
    if (countRejections) incrementRejection(debug, precheck.reason);
    return precheck.reason;
  }

  if (!existingPrecheck && hasDuplicate(seen, basic)) {
    if (countRejections) {
      debug.removedAsDuplicate += 1;
      debug.duplicatesRemoved += 1;
    }
    return "duplicate";
  }

  let details;
  try {
    if (await isDiscoveryStopRequested(options)) return "stopped";
    details = await cachedPlaceDetails(basic.googlePlaceId, {
      storage,
      metrics,
      businessName: basic.businessName,
    });
    debug.enrichedWithPlaceDetails += 1;
  } catch (error) {
    if (countRejections) {
      debug.removedByRelevanceFilter += 1;
      debug.irrelevantRejected += 1;
    } else {
      debug.removedByRelevanceFilter += 1;
    }
    await log(
      "Lead Discovery Agent",
      "warn",
      `Place Details skipped ${basic.businessName}: ${truncate(error.message, 220)}.`,
    );
    return "details";
  }

  await updateRun?.(runId, {
    currentStep: "Scanning websites",
    progressDone: leads.length,
    progressTotal: leadCount,
  });

  if (await isDiscoveryStopRequested(options)) return "stopped";
  const enriched = await enrichQualifiedLead(
    { ...basic, ...normalizePlaceDetails(details) },
    profile,
    precheck,
    { scanWebsite: true, metrics, storage, websiteLimiter },
  );

  const websiteCheck = websitePreferenceCheck(enriched, options.filters?.websiteFilter);
  if (!websiteCheck.ok) {
    debug.removedByWebsiteFilter += 1;
    if (countRejections) debug.irrelevantRejected += 1;
    return "website";
  }

  const opportunityCheck = opportunityPreferenceCheck(enriched, options.filters?.opportunityFilter);
  if (!opportunityCheck.ok) {
    debug.removedByOpportunityFilter += 1;
    if (countRejections) debug.irrelevantRejected += 1;
    return "opportunity";
  }

  const contactCheck = contactPreferenceCheck(enriched, contactPreference);
  if (!contactCheck.ok) {
    if (countRejections) {
      debug.removedByRelevanceFilter += 1;
      debug.irrelevantRejected += 1;
    }
    if (!countRejections) debug.removedByRelevanceFilter += 1;
    return "relevance";
  }

  if (hasDuplicateAfterEnrichment(seen, basic, enriched)) {
    debug.removedAsDuplicate += 1;
    debug.duplicatesRemoved += 1;
    return "duplicate";
  }

  if (leads.length >= leadCount) return "full";
  if (await isDiscoveryStopRequested(options)) return "stopped";

  addDedupeKeys(seen, enriched);
  const status = leadStatusFromContact(enriched);
  const lead = {
    leadId: id("lead"),
    runId,
    businessName: enriched.businessName,
    websiteUrl: enriched.websiteUrl,
    location,
    address: enriched.address,
    phone: enriched.phone,
    email: enriched.email,
    googleRating: enriched.googleRating,
    reviewCount: enriched.reviewCount,
    googlePlaceId: enriched.googlePlaceId,
    googleMapsUrl: enriched.googleMapsUrl,
    contactPageUrl: enriched.contactPageUrl,
    bookingPageUrl: enriched.bookingPageUrl,
    relevanceScore: precheck.score,
    acceptedReason: precheck.reasonAccepted,
    websiteStatus: enriched.websiteStatus,
    visibilityScore: enriched.visibilityScore,
    visibilityTier: enriched.visibilityTier,
    searchPoint: enriched.searchPoint,
    searchRank: enriched.searchRank,
    opportunityFlags: enriched.opportunityFlags,
    sourceUrl: enriched.googleMapsUrl,
    status,
    niche,
    notes,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    error: "",
  };

  await storage.append("Leads", lead);
  leads.push(lead);
  debug.qualifiedLeads = leads.length;
  debug.finalQualifiedLeads = leads.length;
  await updateDiscoveryDebug(updateRun, runId, debug, leadCount);
  await log(
    "Lead Discovery Agent",
    "info",
    `Accepted ${lead.businessName} (${lead.relevanceScore}/100): ${lead.acceptedReason}.`,
    lead.leadId,
  );
  return "accepted";
}

async function cachedGeocodeLocation(address, { storage, metrics } = {}) {
  const cacheKey = hashKey(["geocode", normalizeCacheText(address)]);
  if (storage) {
    const cached = await storage.findById("GeocodeCache", "cacheKey", cacheKey);
    if (isFresh(cached?.updatedAt || cached?.cachedAt, config.geocodeCacheTtlDays || 30)) {
      const lat = Number(cached.lat);
      const lng = Number(cached.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        recordUsage(metrics, "geocodingCacheHits", "google_geocoding_cache_hit", { address });
        return { lat, lng };
      }
    }
  }

  const location = await geocodeLocation(address, metrics);
  if (storage) {
    const timestamp = nowIso();
    const record = {
      cacheKey,
      address,
      lat: location.lat,
      lng: location.lng,
      cachedAt: timestamp,
      updatedAt: timestamp,
    };
    const existing = await storage.findById("GeocodeCache", "cacheKey", cacheKey);
    if (existing) await storage.updateById("GeocodeCache", "cacheKey", cacheKey, record);
    else await storage.append("GeocodeCache", record);
  }
  return location;
}

async function geocodeLocation(address, metrics) {
  recordUsage(metrics, "geocoding", "google_geocoding", { address });
  const url = new URL(GEOCODING_URL);
  url.searchParams.set("address", address);
  url.searchParams.set("key", config.search.googleGeocodingApiKey);

  const data = await fetchJson(url, { timeoutMs: GOOGLE_API_TIMEOUT_MS });
  if (data.status !== "OK" || !data.results?.length) {
    throw new Error(`Geocoding failed for "${address}": ${data.status || "NO_RESULTS"}`);
  }

  const location = data.results[0].geometry?.location;
  if (!location) throw new Error(`Geocoding returned no coordinates for "${address}".`);
  return { lat: location.lat, lng: location.lng };
}

async function nearbySearch({ center, radiusMeters, includedType, metrics }) {
  recordUsage(metrics, "nearby", "google_places_nearby_search", {
    includedType,
    radiusMeters,
  });
  const response = await fetch(NEARBY_SEARCH_URL, {
    method: "POST",
    signal: AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": config.search.googlePlacesApiKey,
      "X-Goog-FieldMask": NEARBY_FIELD_MASK,
    },
    body: JSON.stringify({
      includedTypes: [includedType],
      maxResultCount: 20,
      rankPreference: "POPULARITY",
      locationRestriction: {
        circle: {
          center: {
            latitude: center.lat,
            longitude: center.lng,
          },
          radius: radiusMeters,
        },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} ${truncate(text, 300)}`);
  }

  const data = await response.json();
  return data.places || [];
}

async function* textSearchPages({ textQuery, center, radiusMeters, maxPages, metrics }) {
  let pageToken = "";
  let page = 0;
  const baseBody = {
    textQuery,
    pageSize: TEXT_SEARCH_PAGE_SIZE,
    languageCode: "en",
    locationBias: {
      circle: {
        center: {
          latitude: center.lat,
          longitude: center.lng,
        },
        radius: radiusMeters,
      },
    },
  };

  do {
    if (pageToken) await sleep(TEXT_SEARCH_PAGE_DELAY_MS);
    const data = await textSearch({
      ...baseBody,
      ...(pageToken ? { pageToken } : {}),
    }, metrics);
    page += 1;
    yield data.places || [];
    pageToken = data.nextPageToken || "";
  } while (pageToken && page < maxPages);
}

async function textSearch(body, metrics) {
  recordUsage(metrics, "textSearch", "google_places_text_search", {
    textQuery: body.textQuery || "",
  });
  const response = await fetch(TEXT_SEARCH_URL, {
    method: "POST",
    signal: AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": config.search.googlePlacesApiKey,
      "X-Goog-FieldMask": TEXT_SEARCH_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} ${truncate(text, 300)}`);
  }

  return response.json();
}

async function cachedSearchResults(cacheKey, { storage, metrics } = {}) {
  if (!storage || !cacheKey) return [];
  const cached = await storage.findById("SearchCache", "cacheKey", cacheKey);
  if (!isFresh(cached?.updatedAt || cached?.cachedAt, config.searchCacheTtlDays || 7)) {
    return [];
  }

  const rawJson = parseCachedJson(cached.rawJson);
  const places = Array.isArray(rawJson?.rawPlaces)
    ? rawJson.rawPlaces
    : Array.isArray(rawJson)
      ? rawJson
      : [];
  if (places.length) {
    recordUsage(metrics, "searchCacheHits", "google_places_search_cache_hit", {
      cacheKey,
      places: places.length,
    });
  }
  return places;
}

async function saveSearchResultsCache(storage, cacheKey, payload) {
  if (!storage || !cacheKey || !payload.rawPlaces?.length) return;

  const timestamp = nowIso();
  const rawPlaces = uniquePlaces(payload.rawPlaces).slice(0, 750);
  const record = {
    cacheKey,
    niche: payload.niche,
    location: payload.location,
    radiusKm: payload.radiusKm,
    reviewFilterEnabled: payload.reviewFilterEnabled ? "true" : "false",
    minReviews: payload.minReviews,
    maxReviews: payload.maxReviews,
    searchDepth: payload.searchDepth || "",
    websiteFilter: payload.websiteFilter || "",
    visibilityFilter: payload.visibilityFilter || "",
    opportunityFilter: payload.opportunityFilter || "",
    cachedAt: timestamp,
    updatedAt: timestamp,
    rawJson: { rawPlaces },
  };
  const existing = await storage.findById("SearchCache", "cacheKey", cacheKey);
  if (existing) await storage.updateById("SearchCache", "cacheKey", cacheKey, record);
  else await storage.append("SearchCache", record);
}

async function cachedPlaceDetails(placeId, { storage, metrics, businessName = "" } = {}) {
  const googlePlaceId = normalizePlaceId(placeId);
  if (storage && googlePlaceId) {
    const cached = await storage.findById("PlaceCache", "googlePlaceId", googlePlaceId);
    const cachedJson = freshCachedPlaceJson(cached);
    if (cachedJson) {
      recordUsage(metrics, "placeDetailsCacheHits", "google_place_details_cache_hit", {
        googlePlaceId,
      });
      return cachedJson;
    }
  }

  const details = await placeDetails(placeId, metrics);
  if (storage && googlePlaceId) {
    await savePlaceDetailsCache(storage, googlePlaceId, details, businessName);
  }
  return details;
}

async function placeDetails(placeId, metrics) {
  recordUsage(metrics, "placeDetails", "google_place_details", {
    googlePlaceId: normalizePlaceId(placeId),
  });
  const resource = placeId.startsWith("places/") ? placeId : `places/${placeId}`;
  const response = await fetch(`https://places.googleapis.com/v1/${resource}`, {
    method: "GET",
    signal: AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS),
    headers: {
      "X-Goog-Api-Key": config.search.googlePlacesApiKey,
      "X-Goog-FieldMask": DETAILS_FIELD_MASK,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Place Details failed for ${placeId}: HTTP ${response.status} ${truncate(text, 300)}`);
  }

  return response.json();
}

function freshCachedPlaceJson(cached) {
  if (!cached) return null;
  if (!isFresh(cached.updatedAt || cached.cachedAt, config.placeCacheTtlDays || 30)) return null;
  return parseCachedJson(cached.rawJson);
}

async function savePlaceDetailsCache(storage, googlePlaceId, details, fallbackName = "") {
  const normalized = normalizePlaceDetails(details);
  const existing = await storage.findById("PlaceCache", "googlePlaceId", googlePlaceId);
  const timestamp = nowIso();
  const record = {
    googlePlaceId,
    businessName: normalized.businessName || fallbackName || "",
    formattedAddress: normalized.address || "",
    phone: normalized.phone || "",
    websiteUrl: normalized.websiteUrl || "",
    googleMapsUrl: normalized.googleMapsUrl || "",
    rating: normalized.googleRating || "",
    reviewCount: normalized.reviewCount || "",
    businessStatus: normalized.businessStatus || "",
    cachedAt: existing?.cachedAt || timestamp,
    updatedAt: timestamp,
    rawJson: details,
  };

  if (existing) {
    await storage.updateById("PlaceCache", "googlePlaceId", googlePlaceId, record);
    return;
  }

  try {
    await storage.append("PlaceCache", record);
  } catch {
    await storage.updateById("PlaceCache", "googlePlaceId", googlePlaceId, record);
  }
}

function normalizeNearbyPlace(place, niche, searchLocation) {
  const searchMeta = place.__searchMeta || {};
  const visibility = visibilityFromSearchMeta(searchMeta);
  return {
    businessName: place.displayName?.text || "",
    address: place.formattedAddress || "",
    googleRating: place.rating || "",
    reviewCount: Number(place.userRatingCount || 0),
    googlePlaceId: place.id || "",
    googleMapsUrl: "",
    phone: "",
    websiteUrl: "",
    email: "",
    contactPageUrl: "",
    bookingPageUrl: "",
    websiteStatus: "Not checked",
    businessStatus: place.businessStatus || "",
    primaryType: place.primaryType || "",
    types: place.types || [],
    placeLat: place.location?.latitude || "",
    placeLng: place.location?.longitude || "",
    visibilityScore: visibility.score,
    visibilityTier: visibility.tier,
    searchPoint: searchMeta.pointLabel || "center",
    searchRank: searchMeta.rank || "",
    searchSource: searchMeta.source || "",
    searchTerm: searchMeta.searchTerm || "",
    searchPage: searchMeta.pageNumber || "",
    opportunityFlags: "",
    niche,
    location: searchLocation,
  };
}

function normalizePlaceDetails(place) {
  return {
    businessName: place.displayName?.text || "",
    address: place.formattedAddress || "",
    phone: place.nationalPhoneNumber || place.internationalPhoneNumber || "",
    websiteUrl: normalizeUrl(place.websiteUri || ""),
    googleMapsUrl: place.googleMapsUri || "",
    googleRating: place.rating || "",
    reviewCount: Number(place.userRatingCount || 0),
    businessStatus: place.businessStatus || "",
  };
}

function normalizePlaceId(placeId) {
  return String(placeId || "").replace(/^places\//, "").trim();
}

function precheckPlace(place, profile, reviewRange, filters = {}) {
  const {
    enabled = true,
    minReviews,
    maxReviews,
    expanded = false,
    maxReviewsLabel = maxReviews,
  } = reviewRange;

  if (place.businessStatus !== "OPERATIONAL") {
    return reject("status", "business is not operational");
  }

  if (enabled && (place.reviewCount < minReviews || place.reviewCount > maxReviews)) {
    return reject("review", `review count ${place.reviewCount} is outside ${minReviews}-${maxReviews}`);
  }

  if (!visibilityMatches(place, filters.visibilityFilter)) {
    return reject("visibility", `visibility tier ${place.visibilityTier || "unknown"} does not match filter`);
  }

  const combined = [
    place.businessName,
    place.primaryType,
    ...(place.types || []),
    place.address,
  ].join(" ");

  const negative = matchedTerm(combined, [...REJECT_KEYWORDS, ...(profile.rejectKeywords || [])]);
  if (negative) return reject("relevance", `matched reject keyword "${negative}"`);

  const nicheSignal = nicheMatchesPlace(place, profile);
  const nameMatch = containsAny(place.businessName, profile.acceptedKeywords);
  const categoryMatch = categoryMatches(place, profile);
  const ratingExists = Boolean(place.googleRating);
  const reviewInRange = !enabled || (place.reviewCount >= minReviews && place.reviewCount <= maxReviews);
  const noNegative = !negative;
  const score =
    (nameMatch ? 35 : 0) +
    (categoryMatch ? 25 : 0) +
    (ratingExists ? 15 : 0) +
    (reviewInRange ? 15 : 0) +
    (noNegative ? 10 : 0);

  if (!nicheSignal) {
    return reject("relevance", "does not match niche keywords or strict target place types", score);
  }

  if (score < 50) {
    return reject("relevance", `relevance score ${score} is under 50`, score);
  }

  return {
    accepted: true,
    score,
    reasonAccepted: [
      nameMatch && "business name matches niche keyword",
      categoryMatch && "Google primary/type matches target category",
      ratingExists && "rating exists",
      reviewInRange &&
        (!enabled
          ? "review filter is off"
          : expanded
          ? `review count is within expanded range up to ${maxReviewsLabel}`
          : "review count is within requested range"),
      noNegative && "no reject keywords detected",
    ]
      .filter(Boolean)
      .join("; "),
  };
}

async function enrichQualifiedLead(place, profile, precheck, options = {}) {
  const { scanWebsite = true, metrics, storage, websiteLimiter } = options;
  let websiteUrl = place.websiteUrl;
  let websiteStatus = "No official website found";
  let email = "";
  let contactPageUrl = "";
  let bookingPageUrl = "";

  if (websiteUrl) {
    const domain = domainFromUrl(websiteUrl);
    if (isDirectoryDomain(domain)) {
      websiteUrl = "";
      websiteStatus = "No official website found";
    } else if (!scanWebsite) {
      websiteStatus = "Official website found; website scan deferred to Scrape Agent";
    } else {
      const scan = await cachedWebsiteScan(websiteUrl, profile, place, {
        storage,
        metrics,
        websiteLimiter,
      });
      websiteStatus = scan.websiteStatus || "Official website found";
      email = scan.email || "";
      contactPageUrl = scan.contactPageUrl || "";
      bookingPageUrl = scan.bookingPageUrl || "";
    }
  }

  return {
    ...place,
    websiteUrl,
    email,
    contactPageUrl,
    bookingPageUrl,
    websiteStatus,
    opportunityFlags: opportunityFlagsForLead({ ...place, websiteUrl, contactPageUrl, bookingPageUrl, websiteStatus }).join(" | "),
    relevanceScore: precheck.score,
    acceptedReason: precheck.reasonAccepted,
  };
}

async function cachedWebsiteScan(websiteUrl, profile, place, options = {}) {
  const { storage, metrics, websiteLimiter } = options;
  const domain = domainFromUrl(websiteUrl);
  if (!domain) return { websiteStatus: "Official website found; homepage could not be scanned" };

  if (storage) {
    const cached = await storage.findById("WebsiteScanCache", "domain", domain);
    if (isFresh(cached?.updatedAt || cached?.cachedAt, config.websiteScanCacheTtlDays || 14)) {
      recordUsage(metrics, "websiteScanCacheHits", "website_scan_cache_hit", { domain });
      return {
        email: cached.email || "",
        contactPageUrl: cached.contactPageUrl || "",
        bookingPageUrl: cached.bookingPageUrl || "",
        websiteStatus: cached.websiteStatus || "Official website found",
      };
    }
  }

  const runScan = () => scanWebsiteForContact(websiteUrl, profile, place, metrics);
  const scan = websiteLimiter ? await websiteLimiter(runScan) : await runScan();
  if (storage) await saveWebsiteScanCache(storage, domain, websiteUrl, scan);
  return scan;
}

async function scanWebsiteForContact(websiteUrl, profile, place, metrics) {
  let websiteStatus = "Official website found";
  try {
    recordUsage(metrics, "websiteScans", "website_scan_discovery", {
      domain: domainFromUrl(websiteUrl),
    });
    const response = await fetchText(websiteUrl, { timeoutMs: WEBSITE_SCAN_TIMEOUT_MS });
    if (!response.ok || !/html/i.test(response.contentType)) {
      return {
        email: "",
        contactPageUrl: "",
        bookingPageUrl: "",
        websiteStatus: `Official website found; homepage returned HTTP ${response.status}`,
      };
    }

    const links = extractLinks(response.text, response.url);
    const contact = extractVisibleContact(response.text);
    const titleAndText = `${extractTitle(response.text)} ${extractHomepageText(response.text)}`;
    if (
      !containsAny(titleAndText, profile.acceptedKeywords) &&
      !containsAny(place.businessName, profile.acceptedKeywords)
    ) {
      websiteStatus = "Official website found; niche terms not visible on homepage";
    }

    return {
      email: contact.emails[0] || extractEmails(response.text)[0] || "",
      contactPageUrl: findContactPage(links),
      bookingPageUrl: findBookingPage(links),
      websiteStatus,
    };
  } catch {
    return {
      email: "",
      contactPageUrl: "",
      bookingPageUrl: "",
      websiteStatus: "Official website found; homepage could not be scanned",
    };
  }
}

async function saveWebsiteScanCache(storage, domain, websiteUrl, scan) {
  const timestamp = nowIso();
  const existing = await storage.findById("WebsiteScanCache", "domain", domain);
  const record = {
    domain,
    websiteUrl,
    email: scan.email || "",
    contactPageUrl: scan.contactPageUrl || "",
    bookingPageUrl: scan.bookingPageUrl || "",
    websiteStatus: scan.websiteStatus || "",
    cachedAt: existing?.cachedAt || timestamp,
    updatedAt: timestamp,
  };
  if (existing) await storage.updateById("WebsiteScanCache", "domain", domain, record);
  else await storage.append("WebsiteScanCache", record);
}

function searchPlans(niche, profile, searchDepth = "smart") {
  const terms = uniq([niche, ...profile.fallbackTerms]);
  const limit = searchDepth === "fast" ? 3 : searchDepth === "deep" ? terms.length : Math.min(8, terms.length);
  return terms.map((term) => ({
    term,
    types: uniq(profile.typeMap[term.toLowerCase()] || profile.typeMap.default || []),
  })).slice(0, limit);
}

function normalizeReviewRange(minReviews, maxReviews, enabled = true) {
  const min = Math.max(0, Number(minReviews) || 0);
  const max = Math.max(min, Number(maxReviews) || 0);
  return {
    enabled: Boolean(enabled),
    minReviews: min,
    maxReviews: max,
    maxReviewsLabel: `${max} reviews`,
    expanded: false,
  };
}

function normalizeDiscoveryFilters(input = {}) {
  return {
    searchDepth: normalizeSearchDepth(input.searchDepth),
    websiteFilter: normalizeWebsiteFilter(input.websiteFilter),
    visibilityFilter: normalizeVisibilityFilter(input.visibilityFilter),
    opportunityFilter: normalizeOpportunityFilter(input.opportunityFilter),
  };
}

function normalizeSearchDepth(value) {
  const normalized = String(value || "smart").trim().toLowerCase();
  if (normalized === "fast") return "fast";
  if (["deep", "exhaustive"].includes(normalized)) return "deep";
  return "smart";
}

function normalizeWebsiteFilter(value) {
  const normalized = String(value || "any").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (["has_website", "official_website"].includes(normalized)) return "has_website";
  if (["no_website", "google_profile_only"].includes(normalized)) return "no_website";
  if (["weak_website", "bad_website"].includes(normalized)) return "weak_website";
  return "any";
}

function normalizeVisibilityFilter(value) {
  const normalized = String(value || "any").trim().toLowerCase();
  if (["low", "medium", "high"].includes(normalized)) return normalized;
  return "any";
}

function normalizeOpportunityFilter(value) {
  const normalized = String(value || "any").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (["high_rating_low_reviews", "rating_review_gap"].includes(normalized)) return "high_rating_low_reviews";
  if (["no_booking", "no_booking_page"].includes(normalized)) return "no_booking";
  if (["no_contact", "no_contact_page"].includes(normalized)) return "no_contact";
  if (["no_website", "google_profile_only"].includes(normalized)) return "no_website";
  return "any";
}

function textPageLimit(leadCount, currentCount, searchDepth = "smart") {
  const remaining = Math.max(Number(leadCount || 0) - Number(currentCount || 0), 1);
  const depthLimit = searchDepth === "fast" ? 2 : searchDepth === "deep" ? 8 : 4;
  return Math.min(
    MAX_TEXT_PAGES_PER_QUERY,
    depthLimit,
    Math.max(3, Math.ceil(remaining / TEXT_SEARCH_PAGE_SIZE) + 2),
  );
}

function gridPoints(center, radiusMeters, leadCount, searchDepth = "smart") {
  const depth = normalizeSearchDepth(searchDepth);
  const shouldGrid = depth !== "fast" && (leadCount >= 25 || radiusMeters >= 10000);
  const subRadius = shouldGrid ? Math.max(1200, Math.round(radiusMeters / (depth === "deep" ? 2.4 : 2))) : radiusMeters;
  const points = [{ ...center, label: "center", radiusMeters: subRadius }];
  if (!shouldGrid) return points;

  const innerOffsetKm = Math.max(1.2, radiusMeters / (depth === "deep" ? 2600 : 2200));
  const outerOffsetKm = Math.max(innerOffsetKm * 1.6, radiusMeters / 1500);
  const addRing = (offsetKm, suffix = "") => {
    const latOffset = offsetKm / 111;
    const lngOffset = offsetKm / (111 * Math.cos((center.lat * Math.PI) / 180));
    points.push(
      { lat: center.lat + latOffset, lng: center.lng, label: `north${suffix}`, radiusMeters: subRadius },
      { lat: center.lat - latOffset, lng: center.lng, label: `south${suffix}`, radiusMeters: subRadius },
      { lat: center.lat, lng: center.lng + lngOffset, label: `east${suffix}`, radiusMeters: subRadius },
      { lat: center.lat, lng: center.lng - lngOffset, label: `west${suffix}`, radiusMeters: subRadius },
    );
    if (leadCount >= 50 || depth === "deep") {
      points.push(
        { lat: center.lat + latOffset, lng: center.lng + lngOffset, label: `northeast${suffix}`, radiusMeters: subRadius },
        { lat: center.lat + latOffset, lng: center.lng - lngOffset, label: `northwest${suffix}`, radiusMeters: subRadius },
        { lat: center.lat - latOffset, lng: center.lng + lngOffset, label: `southeast${suffix}`, radiusMeters: subRadius },
        { lat: center.lat - latOffset, lng: center.lng - lngOffset, label: `southwest${suffix}`, radiusMeters: subRadius },
      );
    }
  };

  addRing(innerOffsetKm);
  if (depth === "deep" && (leadCount >= 75 || radiusMeters >= 20000)) addRing(outerOffsetKm, " outer");
  return points.slice(0, depth === "deep" ? 17 : 9);
}

function nicheProfile(niche) {
  const rawNiche = String(niche || "").trim();
  const priority = PROFILE_MATCH_PRIORITY
    .map((key) => NICHE_PROFILES[key])
    .find((profile) => profile?.match.test(rawNiche));
  if (priority) return priority;

  const found = Object.entries(NICHE_PROFILES)
    .filter(([key]) => !PROFILE_MATCH_PRIORITY.includes(key))
    .map(([, profile]) => profile)
    .find((profile) => profile.match.test(rawNiche));
  if (found) return found;

  const tokens = rawNiche
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
  const base = rawNiche.toLowerCase();

  return {
    acceptedKeywords: uniq([base, ...tokens].filter(Boolean)),
    fallbackTerms: uniq([
      base,
      `${base} company`,
      `${base} service`,
      `${base} contractor`,
      `${base} clinic`,
      `${base} specialist`,
    ].filter((term) => term.trim().length > 0)),
    typeMap: { default: ["service"] },
    categoryKeywords: uniq([...tokens, "service"]),
    strictNicheTypeKeywords: [],
  };
}

function categoryMatches(place, profile) {
  const combined = `${place.primaryType || ""} ${(place.types || []).join(" ")}`.toLowerCase();
  return (profile.categoryKeywords || []).some((keyword) => combined.includes(keyword));
}

function visibilityFromSearchMeta(meta = {}) {
  const rank = Number(meta.rank || 0);
  const pageNumber = Number(meta.pageNumber || 1);
  const point = String(meta.pointLabel || "center");
  let score = 52;

  if (point === "center") score += 24;
  else if (!/outer/i.test(point)) score += 10;
  if (rank > 0 && rank <= 5) score += 24;
  else if (rank <= 10) score += 18;
  else if (rank <= 20) score += 10;
  else if (rank <= 40) score += 2;
  else score -= 10;
  if (pageNumber >= 3) score -= 10;
  if (pageNumber >= 5) score -= 8;

  score = Math.max(20, Math.min(100, Math.round(score)));
  return {
    score,
    tier: score >= 82 ? "high" : score >= 58 ? "medium" : "low",
  };
}

function visibilityMatches(place, filter = "any") {
  const normalized = normalizeVisibilityFilter(filter);
  if (normalized === "any") return true;
  return String(place.visibilityTier || "").toLowerCase() === normalized;
}

function nicheMatchesPlace(place, profile) {
  const keywordText = [
    place.businessName,
    place.primaryType,
    ...(place.types || []),
  ]
    .join(" ")
    .toLowerCase();
  const addressText = String(place.address || "").toLowerCase();

  return (
    profile.acceptedKeywords.some((keyword) => {
      const term = keyword.toLowerCase();
      return keywordText.includes(term) || (term.length >= 12 && addressText.includes(term));
    }) ||
    (profile.strictNicheTypeKeywords || []).some((keyword) => keywordText.includes(keyword))
  );
}

function websitePreferenceCheck(lead, filter = "any") {
  const normalized = normalizeWebsiteFilter(filter);
  if (normalized === "any") return { ok: true, message: "" };
  const hasWebsite = Boolean(String(lead.websiteUrl || "").trim());
  const weakWebsite = isWeakWebsiteLead(lead);

  if (normalized === "has_website") {
    return hasWebsite
      ? { ok: true, message: "" }
      : { ok: false, message: "official website required but not found" };
  }
  if (normalized === "no_website") {
    return !hasWebsite
      ? { ok: true, message: "" }
      : { ok: false, message: "lead has an official website" };
  }
  if (normalized === "weak_website") {
    return weakWebsite
      ? { ok: true, message: "" }
      : { ok: false, message: "website does not show a selected weakness" };
  }
  return { ok: true, message: "" };
}

function opportunityPreferenceCheck(lead, filter = "any") {
  const normalized = normalizeOpportunityFilter(filter);
  if (normalized === "any") return { ok: true, message: "" };
  const flags = opportunityFlagsForLead(lead);
  const flagSet = new Set(flags);
  const rating = Number(lead.googleRating || 0);
  const reviews = Number(lead.reviewCount || 0);

  if (normalized === "high_rating_low_reviews") {
    return rating >= 4 && reviews > 0 && reviews <= 35
      ? { ok: true, message: "" }
      : { ok: false, message: "not high rating with low review count" };
  }
  if (normalized === "no_booking") {
    return flagSet.has("No booking page")
      ? { ok: true, message: "" }
      : { ok: false, message: "booking page detected" };
  }
  if (normalized === "no_contact") {
    return flagSet.has("No contact page")
      ? { ok: true, message: "" }
      : { ok: false, message: "contact page detected" };
  }
  if (normalized === "no_website") {
    return flagSet.has("No official website")
      ? { ok: true, message: "" }
      : { ok: false, message: "official website exists" };
  }
  return { ok: true, message: "" };
}

function isWeakWebsiteLead(lead) {
  const flags = opportunityFlagsForLead(lead);
  return flags.some((flag) =>
    ["No booking page", "No contact page", "Weak website signal", "No official website"].includes(flag),
  );
}

function opportunityFlagsForLead(lead) {
  const flags = [];
  const hasWebsite = Boolean(String(lead.websiteUrl || "").trim());
  const websiteStatus = String(lead.websiteStatus || "");
  const rating = Number(lead.googleRating || 0);
  const reviews = Number(lead.reviewCount || 0);

  if (!hasWebsite) flags.push("No official website");
  if (hasWebsite && !String(lead.bookingPageUrl || "").trim()) flags.push("No booking page");
  if (hasWebsite && !String(lead.contactPageUrl || "").trim()) flags.push("No contact page");
  if (/could not be scanned|returned HTTP|niche terms not visible/i.test(websiteStatus)) {
    flags.push("Weak website signal");
  }
  if (rating >= 4 && reviews > 0 && reviews <= 35) flags.push("High rating low reviews");
  if (String(lead.visibilityTier || "").toLowerCase() === "low") flags.push("Low map visibility");
  return uniq(flags);
}

function containsAny(value, keywords) {
  const text = String(value || "").toLowerCase();
  return (keywords || []).some((keyword) => text.includes(keyword.toLowerCase()));
}

function matchedTerm(value, keywords) {
  const text = String(value || "").toLowerCase();
  return keywords.find((keyword) => text.includes(keyword.toLowerCase())) || "";
}

function reject(reason, message, score = 0) {
  return { accepted: false, reason, message, score };
}

function incrementRejection(debug, reason) {
  if (reason === "review") debug.removedByReviewFilter += 1;
  else if (reason === "visibility") debug.removedByVisibilityFilter += 1;
  else if (reason === "website") debug.removedByWebsiteFilter += 1;
  else if (reason === "opportunity") debug.removedByOpportunityFilter += 1;
  else debug.removedByRelevanceFilter += 1;
  debug.irrelevantRejected += 1;
}

function buildExistingDedupe(leads) {
  const seen = { placeIds: new Set(), domains: new Set(), phones: new Set(), nameAddress: new Set() };
  for (const lead of leads) addDedupeKeys(seen, lead);
  return seen;
}

function hasDuplicate(seen, place) {
  const domain = domainFromUrl(place.websiteUrl);
  const phone = normalizePhone(place.phone);
  const nameAddress = normalizedNameAddress(place);
  return Boolean(
    (place.googlePlaceId && seen.placeIds.has(place.googlePlaceId)) ||
      (domain && seen.domains.has(domain)) ||
      (phone && seen.phones.has(phone)) ||
      (nameAddress && seen.nameAddress.has(nameAddress)),
  );
}

function hasDuplicateAfterEnrichment(seen, basic, enriched) {
  const domain = domainFromUrl(enriched.websiteUrl);
  const phone = normalizePhone(enriched.phone);
  const nameAddress = normalizedNameAddress(enriched);
  const basicNameAddress = normalizedNameAddress(basic);
  return Boolean(
    (domain && seen.domains.has(domain)) ||
      (phone && seen.phones.has(phone)) ||
      (nameAddress && nameAddress !== basicNameAddress && seen.nameAddress.has(nameAddress))
  );
}

function addDedupeKeys(seen, place) {
  const domain = domainFromUrl(place.websiteUrl);
  const phone = normalizePhone(place.phone);
  const nameAddress = normalizedNameAddress(place);
  if (place.googlePlaceId) seen.placeIds.add(place.googlePlaceId);
  if (domain) seen.domains.add(domain);
  if (phone) seen.phones.add(phone);
  if (nameAddress) seen.nameAddress.add(nameAddress);
}

function normalizedNameAddress(place) {
  const name = String(place.businessName || "").toLowerCase().replace(/\W+/g, "");
  const address = String(place.address || "").toLowerCase().replace(/\W+/g, "");
  return name && address ? `${name}:${address}` : "";
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function isDirectoryDomain(domain) {
  return DIRECTORY_DOMAINS.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}

function contactPreferenceCheck(lead, preference) {
  const email = String(lead.email || "").trim();
  const phone = String(lead.phone || "").trim();
  const normalized = String(preference || "any").toLowerCase();

  if (normalized === "email") {
    return email
      ? { ok: true, message: "" }
      : { ok: false, message: "Campaign requires email, but no email address was found." };
  }

  if (normalized === "email_phone") {
    return email && phone
      ? { ok: true, message: "" }
      : {
          ok: false,
          message: "Campaign requires email + phone, but both contact methods were not found.",
        };
  }

  return email || phone
    ? { ok: true, message: "" }
    : { ok: false, message: "No email or phone found after checking Google profile and website." };
}

function leadStatusFromContact(lead) {
  if (String(lead.email || "").trim()) return "Pending Approval";
  if (String(lead.phone || "").trim()) return "Phone Only";
  return "New";
}

function buildSearchCacheKey(input) {
  return hashKey([
    "search",
    normalizeCacheText(input.niche),
    normalizeCacheText(input.location),
    Number(input.locationLat || 0).toFixed(5),
    Number(input.locationLng || 0).toFixed(5),
    Number(input.radiusKm || 0).toFixed(2),
    normalizeSearchDepth(input.searchDepth),
  ]);
}

function normalizeCacheText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function hashKey(parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function isFresh(value, ttlDays) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return false;
  const ttlMs = Math.max(1, Number(ttlDays) || 1) * 24 * 60 * 60 * 1000;
  return Date.now() - timestamp <= ttlMs;
}

function parseCachedJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function uniquePlaces(places) {
  const seenIds = new Set();
  const results = [];
  for (const place of places || []) {
    const key = place.id || `${place.displayName?.text || ""}:${place.formattedAddress || ""}`;
    if (!key || seenIds.has(key)) continue;
    seenIds.add(key);
    results.push(place);
  }
  return results;
}

async function mapConcurrent(items, limit, worker) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

function createLimiter(limit) {
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= limit || !queue.length) return;
    active += 1;
    const job = queue.shift();
    job();
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push(async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        } finally {
          active -= 1;
          runNext();
        }
      });
      runNext();
    });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyMetrics(trackUsage) {
  return {
    startedAt: Date.now(),
    trackUsage,
    geocoding: 0,
    geocodingCacheHits: 0,
    textSearch: 0,
    nearby: 0,
    searchCacheHits: 0,
    placeDetails: 0,
    placeDetailsCacheHits: 0,
    websiteScans: 0,
    websiteScanCacheHits: 0,
  };
}

function formatMetrics(metrics) {
  const googleApiCalls =
    metrics.geocoding + metrics.textSearch + metrics.nearby + metrics.placeDetails;
  const seconds = Math.round((Date.now() - metrics.startedAt) / 100) / 10;
  return `Google API calls used: ${googleApiCalls} total (${metrics.geocoding} Geocoding, ${metrics.textSearch} Text Search, ${metrics.nearby} Nearby Search, ${metrics.placeDetails} Place Details). Cache hits: ${metrics.geocodingCacheHits} geocode, ${metrics.searchCacheHits} search, ${metrics.placeDetailsCacheHits} details, ${metrics.websiteScanCacheHits} website. Website scans during discovery: ${metrics.websiteScans}. Discovery time: ${seconds}s.`;
}

function recordUsage(metrics, metricKey, usageType, metadata = {}) {
  if (!metrics) return;
  metrics[metricKey] = Number(metrics[metricKey] || 0) + 1;
  if (typeof metrics.trackUsage === "function") {
    metrics.trackUsage(usageType, 1, metadata);
  }
}

function emptyDebug() {
  return {
    rawPlacesFound: 0,
    rawResultsFound: 0,
    duplicatesRemoved: 0,
    irrelevantRejected: 0,
    qualifiedLeads: 0,
    removedByReviewFilter: 0,
    removedByRelevanceFilter: 0,
    removedByVisibilityFilter: 0,
    removedByWebsiteFilter: 0,
    removedByOpportunityFilter: 0,
    removedAsDuplicate: 0,
    enrichedWithPlaceDetails: 0,
    finalQualifiedLeads: 0,
  };
}

async function updateDiscoveryDebug(updateRun, runId, debug, requestedCount, message = "") {
  debug.rawResultsFound = debug.rawPlacesFound;
  debug.duplicatesRemoved = debug.removedAsDuplicate;
  debug.irrelevantRejected =
    debug.removedByReviewFilter +
    debug.removedByRelevanceFilter +
    debug.removedByVisibilityFilter +
    debug.removedByWebsiteFilter +
    debug.removedByOpportunityFilter;
  debug.finalQualifiedLeads = debug.qualifiedLeads;

  if (!updateRun) return;
  await updateRun(runId, {
    rawResultsFound: debug.rawResultsFound,
    duplicatesRemoved: debug.duplicatesRemoved,
    irrelevantRejected: debug.irrelevantRejected,
    qualifiedLeads: debug.qualifiedLeads,
    removedByReviewFilter: debug.removedByReviewFilter,
    removedByRelevanceFilter: debug.removedByRelevanceFilter,
    removedByVisibilityFilter: debug.removedByVisibilityFilter,
    removedByWebsiteFilter: debug.removedByWebsiteFilter,
    removedByOpportunityFilter: debug.removedByOpportunityFilter,
    removedAsDuplicate: debug.removedAsDuplicate,
    enrichedWithPlaceDetails: debug.enrichedWithPlaceDetails,
    finalQualifiedLeads: debug.finalQualifiedLeads,
    progressDone: debug.qualifiedLeads,
    progressTotal: requestedCount,
    discoveryMessage:
      message ||
      `Found ${debug.qualifiedLeads}/${requestedCount} qualified leads after filtering.`,
  });
}
