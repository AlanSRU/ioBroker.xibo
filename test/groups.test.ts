import { expect } from 'chai';
import { chooseGroupBranch, groupRenameAction, GroupBranch } from '../src/lib/xibo-types';

/**
 * Two defects lived here, and both were decision bugs rather than plumbing:
 * the wrong branch was adopted when the tree held more than one, and a user's
 * own rename in admin was mistaken for a rename in Xibo and reverted.
 */

const branch = (objectId: string, cmsName: string | undefined, channelName?: string): GroupBranch => ({
    objectId,
    cmsName,
    channelName: channelName ?? cmsName ?? objectId,
});

describe('chooseGroupBranch', () => {
    it('prefers the branch whose recorded CMS name still matches', () => {
        // 0.2.0 left a second branch after a rename, both carrying the same
        // displayGroupId. Taking the first one adopted the older, dead branch
        // and left the one a deck was rebound to unindexed, where every press
        // failed with "not in the CMS any more" — which was untrue.
        const candidates = [branch('displayGroups.led_walls', 'LED Walls'), branch('displayGroups.north_wall', 'North Wall')];
        expect(chooseGroupBranch(candidates, 'North Wall', 'displayGroups.north_wall')!.objectId).to.equal(
            'displayGroups.north_wall',
        );
    });

    it('falls back to the id the current name folds to', () => {
        // A branch from before the CMS name was recorded has nothing to match.
        const candidates = [branch('displayGroups.old', undefined), branch('displayGroups.north_wall', undefined)];
        expect(chooseGroupBranch(candidates, 'North Wall', 'displayGroups.north_wall')!.objectId).to.equal(
            'displayGroups.north_wall',
        );
    });

    it('falls back to the first when nothing matches, rather than giving up', () => {
        const candidates = [branch('displayGroups.a', undefined), branch('displayGroups.b', undefined)];
        expect(chooseGroupBranch(candidates, 'Whatever', 'displayGroups.whatever')!.objectId).to.equal(
            'displayGroups.a',
        );
    });

    it('returns nothing when the tree has no branch for the group', () => {
        expect(chooseGroupBranch([], 'LED Walls', 'displayGroups.led_walls')).to.equal(undefined);
    });

    it('is not fooled by a user-renamed label', () => {
        // The label is the user's; only the recorded CMS name identifies it.
        const candidates = [
            branch('displayGroups.led_walls', 'LED Walls', 'Main wall (do not touch)'),
            branch('displayGroups.led_walls_2', 'Something else'),
        ];
        expect(chooseGroupBranch(candidates, 'LED Walls', 'displayGroups.led_walls')!.objectId).to.equal(
            'displayGroups.led_walls',
        );
    });
});

describe('groupRenameAction', () => {
    it('does nothing when the CMS name is unchanged', () => {
        const plan = groupRenameAction(branch('displayGroups.led_walls', 'LED Walls'), 'LED Walls');
        expect(plan.changed).to.equal(false);
        expect(plan.updateLabel).to.equal(false);
    });

    it('moves the label along on a real CMS rename', () => {
        const plan = groupRenameAction(branch('displayGroups.led_walls', 'LED Walls'), 'North Wall');
        expect(plan.changed).to.equal(true);
        expect(plan.userRenamed).to.equal(false);
        expect(plan.updateLabel).to.equal(true);
    });

    it("leaves a label the user has claimed, even on a real CMS rename", () => {
        const plan = groupRenameAction(
            branch('displayGroups.led_walls', 'LED Walls', 'Main wall (do not touch)'),
            'North Wall',
        );
        expect(plan.changed).to.equal(true);
        expect(plan.userRenamed).to.equal(true);
        expect(plan.updateLabel).to.equal(false);
    });

    it('never reverts a rename made only in admin', () => {
        // The CMS name has not moved; only the label has. Comparing the label
        // instead of the record made this look like a CMS rename, so the
        // adapter overwrote the user's name and logged a rename that had never
        // happened — while the comment beside it said the object was left
        // create-only precisely so a user rename would survive.
        const plan = groupRenameAction(
            branch('displayGroups.led_walls', 'LED Walls', 'Main wall (do not touch)'),
            'LED Walls',
        );
        expect(plan.changed).to.equal(false);
        expect(plan.updateLabel).to.equal(false);
    });

    it('fills in a missing record silently, without claiming a rename', () => {
        // A branch created before the CMS name was recorded: nothing is known
        // about whether the label was ever the CMS's, so it is left alone.
        const plan = groupRenameAction(branch('displayGroups.led_walls', undefined), 'LED Walls');
        expect(plan.firstRecord).to.equal(true);
        expect(plan.updateLabel).to.equal(false);
    });
});
