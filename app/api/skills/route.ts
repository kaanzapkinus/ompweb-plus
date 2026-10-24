import { NextResponse } from "next/server";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { basename } from "path";
import { homedir } from "os";
import {
  getSkillToggleRoots,
  isReadOnlySkill,
  loadSkillsWithInstallInfo,
  parseSkillFrontmatter,
  readDisableModelInvocation,
  setDisableModelInvocation,
} from "@/lib/skills-service";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";

export const dynamic = "force-dynamic";

// GET /api/skills?cwd=<path>
// Lists what omp resolves (`omp skill list --json`), falling back to a scan
// of omp's skill roots on binaries that predate the command. Each skill
// carries `togglable`, the same check PATCH applies.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required", code: "cwd_required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }
    return NextResponse.json(await loadSkillsWithInstallInfo(cwd));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// PATCH /api/skills — toggle disable-model-invocation on a SKILL.md file
export async function PATCH(req: Request) {
  try {
    const body = await req.json() as { filePath: string; disableModelInvocation: boolean; cwd?: string };
    const { filePath, disableModelInvocation, cwd } = body;
    if (!filePath) return NextResponse.json({ error: "filePath required", code: "file_path_required" }, { status: 400 });
    if (typeof disableModelInvocation !== "boolean") {
      return NextResponse.json({ error: "disableModelInvocation must be boolean" }, { status: 400 });
    }
    if (basename(filePath) !== "SKILL.md") {
      return NextResponse.json({ error: "not a SKILL.md file", code: "not_a_skill_file" }, { status: 400 });
    }
    if (!existsSync(filePath)) return NextResponse.json({ error: "file not found", code: "file_not_found" }, { status: 404 });
    // Filesystem access and runtime ownership are separate checks. In
    // particular, a plugin inside an allowed workspace is still read-only.
    const allowedRoots = await getSkillToggleRoots(cwd);
    // Resolve symlinks once up front and authorize the resolved path: the
    // read/write below then operate on the same resolved path, so a symlink
    // swapped between the authorization check and the write cannot redirect
    // it outside the checked roots.
    const resolvedFilePath = realpathSync(filePath);
    if (!isExistingFilePathAllowed(resolvedFilePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }
    const { skills } = await loadSkillsWithInstallInfo(cwd ?? homedir());
    const listed = skills.find((skill) => {
      try { return realpathSync(skill.filePath) === resolvedFilePath; } catch { return false; }
    });
    if (isReadOnlySkill(listed ?? { name: "", description: "", filePath: resolvedFilePath, baseDir: "", disableModelInvocation: false, sourceInfo: {} })) {
      return NextResponse.json({ error: "Managed and plugin skills are read-only", code: "access_denied" }, { status: 403 });
    }

    const content = readFileSync(resolvedFilePath, "utf8");
    const updated = setDisableModelInvocation(content, disableModelInvocation);
    if (updated !== content) writeFileSync(resolvedFilePath, updated, "utf8");

    // Report what the file now says rather than what was asked for.
    const { frontmatter } = parseSkillFrontmatter(updated);
    return NextResponse.json({ success: true, disableModelInvocation: readDisableModelInvocation(frontmatter) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
