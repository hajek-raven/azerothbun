import type { Database } from "bun:sqlite";
import type { Character } from "../db.ts";
import type { CharacterLoginKit } from "./store.ts";

export function saveCharacterState(db: Database, character: Character, kit: CharacterLoginKit): void {
  const save = db.transaction(() => {
    db.query(
      `UPDATE characters
       SET zone = $zone, map = $map, position_x = $position_x, position_y = $position_y, position_z = $position_z,
           orientation = $orientation, health = $health, level = $level, xp = $xp, money = $money,
           power1 = $power1, power2 = $power2, power3 = $power3, power4 = $power4,
           power5 = $power5, power6 = $power6, power7 = $power7
       WHERE guid = $guid`,
    ).run({
      guid: character.guid,
      zone: character.zone,
      map: character.map,
      position_x: character.position_x,
      position_y: character.position_y,
      position_z: character.position_z,
      orientation: character.orientation,
      health: character.health,
      level: character.level,
      xp: character.xp,
      money: character.money,
      power1: character.power1,
      power2: character.power2,
      power3: character.power3,
      power4: character.power4,
      power5: character.power5,
      power6: character.power6,
      power7: character.power7,
    });

    const guid = character.guid;
    db.query("DELETE FROM character_spell WHERE guid = $guid").run({ guid });
    db.query("DELETE FROM character_action WHERE guid = $guid").run({ guid });
    db.query("DELETE FROM character_skills WHERE guid = $guid").run({ guid });
    db.query("DELETE FROM character_reputation WHERE guid = $guid").run({ guid });
    db.query("DELETE FROM character_homebind WHERE guid = $guid").run({ guid });

    const insertSpell = db.query(
      "INSERT INTO character_spell (guid, spell, specMask) VALUES ($guid, $spell, 1)",
    );
    for (const spell of kit.spells) {
      insertSpell.run({ guid, spell });
    }

    const insertAction = db.query(
      "INSERT INTO character_action (guid, spec, button, action, type) VALUES ($guid, 0, $button, $action, $type)",
    );
    for (const action of kit.actions) {
      insertAction.run({
        guid,
        button: action.button,
        action: action.action,
        type: action.type,
      });
    }

    const insertSkill = db.query(
      "INSERT INTO character_skills (guid, skill, value, max) VALUES ($guid, $skill, $value, $max)",
    );
    for (const skill of kit.skills) {
      insertSkill.run({
        guid,
        skill: skill.skill,
        value: skill.value,
        max: skill.max,
      });
    }

    const insertFaction = db.query(
      "INSERT INTO character_reputation (guid, faction, standing, flags) VALUES ($guid, $faction, $standing, $flags)",
    );
    for (const faction of kit.factions) {
      insertFaction.run({
        guid,
        faction: faction.faction,
        standing: faction.standing,
        flags: faction.flags,
      });
    }

    if (kit.homebind) {
      db.query(
        `INSERT INTO character_homebind (guid, mapId, zoneId, posX, posY, posZ)
         VALUES ($guid, $mapId, $zoneId, $posX, $posY, $posZ)`,
      ).run({
        guid,
        mapId: kit.homebind.mapId,
        zoneId: kit.homebind.zoneId,
        posX: kit.homebind.posX,
        posY: kit.homebind.posY,
        posZ: kit.homebind.posZ,
      });
    }
  });

  save();
}
