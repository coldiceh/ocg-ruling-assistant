from pathlib import Path
import difflib

def save_preserving_lines(path, old, new):
    a=old.splitlines(keepends=True);b=new.splitlines(keepends=True);out=[]
    for tag,i,j,k,l in difflib.SequenceMatcher(a=[x.rstrip('\r\n') for x in a],b=[x.rstrip('\r\n') for x in b],autojunk=False).get_opcodes():
        if tag=='equal':out+=a[i:j]
        elif tag in ('insert','replace'):
            eol='\r\n' if i<len(a) and a[i].endswith('\r\n') else '\n'
            out+=[x.rstrip('\r\n')+eol for x in b[k:l]]
    path.write_bytes(''.join(out).encode())

p=Path('scripts/lib/manual-capture-evidence-selection.mjs');old=p.read_bytes().decode();s=old.replace('\r\n','\n')
marker='  const declaredTier = String(record.sourceTier || "").trim();\n  const identity'
assert s.count(marker)==1
s=s.replace(marker,'''  const declaredTier = String(record.sourceTier || "").trim();
  // Explicit, consistent official-reference provenance takes precedence over
  // the legacy rule-doc fallback. It is not an official database ruling.
  if (declaredAuthority === "official_reference" && record.official === true
      && (!declaredTier || declaredTier === "S0_OFFICIAL_REFERENCE")) {
    return "official_reference";
  }
  const identity''',1)
a=s.index('  if ((hasAuthority && record.sourceAuthority !== "community_reference")',s.index('function referenceRecordCandidate'));b=s.index('  const id = itemId(record);',a)
s=s[:a]+'''  const officialReference = record.sourceAuthority === "official_reference"
    && record.official === true
    && (!hasTier || record.sourceTier === "S0_OFFICIAL_REFERENCE");
  const communityReference = (!hasAuthority || record.sourceAuthority === "community_reference")
    && (!hasTier || record.sourceTier === "S2_COMMUNITY_REFERENCE")
    && (!hasOfficial || record.official === false);
  if (!officialReference && !communityReference) {
    throw new Error("manual_capture_reference_record_authority_conflict");
  }
  const authority = officialReference ? "official_reference" : "community_reference";
  const tier = officialReference ? "S0_OFFICIAL_REFERENCE" : "S2_COMMUNITY_REFERENCE";
'''+s[b:]
s=s.replace('...(!hasAuthority ? { sourceAuthority: "community_reference" } : {}),','...(!hasAuthority ? { sourceAuthority: authority } : {}),',1).replace('...(!hasTier ? { sourceTier: "S2_COMMUNITY_REFERENCE" } : {}),','...(!hasTier ? { sourceTier: tier } : {}),',1).replace('...(!hasOfficial ? { official: false } : {}),','...(!hasOfficial ? { official: officialReference } : {}),',1)
save_preserving_lines(p,old,s)
p=Path('scripts/build-cloud-evidence-assets.mjs');s=p.read_text();a=s.index('export async function buildCloudEvidenceAssets(');b=s.index('  const data = await loadRagData(dataDir);',a)
s=s[:a]+"async function loadCloudEvidenceCandidates(dataDir) {\n  if (!dataDir) throw new Error('dataDir is required');\n"+s[b:]
a=s.index('  const corpusMetadata = await writeCloudEvidenceCorpus')
s=s[:a]+'''  return {dataRevision, ruleBytes, candidates};
}

// Same candidate/provenance validation as the real builder, before any paid
// providers are invoked. This preflight writes no files and makes no model calls.
export async function validateCloudEvidenceSources({dataDir} = {}) {
  const {dataRevision, candidates} = await loadCloudEvidenceCandidates(dataDir);
  return {dataRevision, candidateCount:candidates.length, validated:true,
    externalCalls:0, embeddingComputations:0};
}

export async function buildCloudEvidenceAssets({dataDir, outputDir, vectorDir} = {}) {
  if (!dataDir || !outputDir) throw new Error('dataDir and new outputDir are required');
  const {dataRevision, ruleBytes, candidates} = await loadCloudEvidenceCandidates(dataDir);
  await fs.mkdir(outputDir, {recursive: false});
'''+s[a:]
a=s.index('  console.log(JSON.stringify(await buildCloudEvidenceAssets(')
s=s[:a]+'''  const options={dataDir:option('--data-dir'), outputDir:option('--output-dir'), vectorDir:option('--vector-dir')};
  console.log(JSON.stringify(args.includes('--validate-only')
    ?await validateCloudEvidenceSources(options):await buildCloudEvidenceAssets(options)));
}
''';p.write_text(s)
p=Path('.github/workflows/sync-data.yml');s=p.read_text();s=s.replace('tests/evidence-sync-budget-speed.test.mjs\n','tests/evidence-sync-budget-speed.test.mjs tests/sync-official-reference.test.mjs\n',1)
s=s.replace('      - name: Incrementally refresh current navigation and Gemini vectors\n','''      - name: Validate cloud source identities and provenance before paid calls
        run: node scripts/build-cloud-evidence-assets.mjs --data-dir data --validate-only

      - name: Incrementally refresh current navigation and Gemini vectors
''',1)
s=s.replace('      - name: Preserve bounded preprocessing diagnostics\n','''      - name: Preserve unpublished source and derived assets after downstream failure
        if: ${{ failure() && steps.data_validation.outcome == 'success' }}
        uses: actions/upload-artifact@v4
        with:
          name: sync-resume-snapshot-${{ github.run_id }}-${{ github.run_attempt }}
          path: |
            data/*.json
            data/*.json.gz
            data/rag-runtime-v1/**
            data/cloud-evidence-v1/**
            data/gemini-rule-qa-v1/**
            data/rule-embedding-v1/**
            data/qa-embedding-v1/**
          if-no-files-found: error
          retention-days: 3
          compression-level: 1

      - name: Preserve bounded preprocessing diagnostics
''',1);p.write_text(s)
