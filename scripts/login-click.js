const { chromium } = require('playwright');
const fs = require('fs');
const eduMails = require('./edu-mails');

// ====== CONFIG (edit these directly, no env vars needed) ======
const USE_EDU_MAILS = true; // set to false to use a fixed email below
const FALLBACK_EMAIL = 'test@example.com'; // used only if USE_EDU_MAILS = false
const SIGNUP_FIRST_NAME = 'Jane';
const SIGNUP_LAST_NAME = `Doe${Date.now().toString().slice(-4)}`;
const SIGNUP_PASSWORD = 'Shawon63@@';
// ================================================================

(async () => {
    fs.mkdirSync('screenshots', { recursive: true });

    const browser = await chromium.launch({
        headless: false,
        args: ['--start-maximized'],
    });

    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    try {
        // --- Step 0: Generate or use fixed email ---
        let tempEmail;
        if (USE_EDU_MAILS) {
            console.log('Generating temporary email via EduMails API...');
            tempEmail = await eduMails.generateEmail({ action: 'random' });
            console.log(`Generated: ${tempEmail.address} (uuid: ${tempEmail.uuid})`);
        } else {
            tempEmail = { address: FALLBACK_EMAIL, uuid: null };
            console.log(`Using fixed email: ${tempEmail.address}`);
        }

        // --- Step 1: Load the site ---
        await page.goto('https://vanceai.com/', { waitUntil: 'domcontentloaded' });
        await page.screenshot({ path: 'screenshots/01-loaded.png' });

        const desktopLoginBtn = page.locator('nav button:has-text("Log in")').first();
        const mobileToggleBtn = page.locator('button[aria-label="Toggle menu"]');
        const mobileLoginBtn = page.locator('button:has-text("Log in")').last();
        const isDesktopVisible = await desktopLoginBtn.isVisible().catch(() => false);

        if (isDesktopVisible) {
            console.log('Desktop layout detected.');
            await desktopLoginBtn.click();
        } else {
            console.log('Mobile layout detected.');
            await mobileToggleBtn.click();
            await page.waitForTimeout(500);
            await page.screenshot({ path: 'screenshots/02-menu-open.png' });
            await mobileLoginBtn.waitFor({ state: 'visible', timeout: 5000 });
            await mobileLoginBtn.click();
        }

        // --- Step 2: Sign in modal appears ---
        const signInHeading = page.getByRole('heading', { name: 'Sign in', level: 2 });
        await signInHeading.waitFor({ state: 'visible', timeout: 10000 });
        await page.screenshot({ path: 'screenshots/03-signin-modal.png' });

        // --- Step 3: Click "Sign up" inside the modal ---
        const dialog = page.locator('[role="dialog"]').first();
        const signUpBtn = dialog.getByRole('button', { name: 'Sign up', exact: true });
        await signUpBtn.waitFor({ state: 'visible', timeout: 5000 });
        await signUpBtn.click();

        // --- Step 4: Sign up form appears ---
        const signUpHeading = page.getByRole('heading', { name: 'Sign up', level: 2 });
        await signUpHeading.waitFor({ state: 'visible', timeout: 10000 });
        await page.screenshot({ path: 'screenshots/04-signup-form.png' });

        // --- Step 5: Fill in email ---
        const emailInput = page.locator('#signup-email');
        await emailInput.waitFor({ state: 'visible', timeout: 5000 });
        await emailInput.fill(tempEmail.address);
        console.log(`Filled email field with: ${tempEmail.address}`);
        await page.screenshot({ path: 'screenshots/05-email-filled.png' });

        // --- Step 6: Submit sign up link ---
        const sendLinkBtn = dialog.getByRole('button', { name: 'Send sign up link' });
        await sendLinkBtn.waitFor({ state: 'visible', timeout: 5000 });
        await sendLinkBtn.click();
        console.log('Send sign up link clicked.');
        await page.waitForTimeout(1000);
        await page.screenshot({ path: 'screenshots/06-after-submit.png' });

        if (!tempEmail.uuid) {
            console.log('No EduMails UUID — skipping auto-verification.');
            return;
        }

        // --- Step 7: Poll inbox for verification email ---
        console.log('Polling inbox for verification email...');
        const messages = await eduMails.waitForMessage(tempEmail.uuid, {
            timeoutMs: 90000,
            intervalMs: 3000,
        });
        const latest = messages[0];
        console.log(`Received email: "${latest.subject}" from ${latest.from}`);

        const { link, code } = eduMails.extractVerification(latest);
        if (code) console.log(`Verification code found: ${code}`);
        if (!link) throw new Error('No verification link found in the email body.');
        console.log(`Verification link found: ${link}`);

        // --- Step 8: Open verification link ---
        console.log('Navigating to verification link...');
        await page.goto(link, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'screenshots/07-verification-opened.png' });

        // --- Step 9: Fill out the "Complete profile" form ---
        console.log('Waiting for "Complete profile" form...');
        const completeProfileHeading = page.getByRole('heading', { name: 'Complete profile', level: 2 });
        await completeProfileHeading.waitFor({ state: 'visible', timeout: 15000 });
        await page.screenshot({ path: 'screenshots/08-complete-profile-form.png' });

        console.log(`Using name: ${SIGNUP_FIRST_NAME} ${SIGNUP_LAST_NAME}`);

        const firstNameInput = page.getByPlaceholder('Jane');
        const lastNameInput = page.getByPlaceholder('Doe');
        const passwordInput = page.getByPlaceholder('Min. 8 characters');
        const confirmPasswordInput = page.getByPlaceholder('Re-enter password');
        const termsCheckbox = page.locator('input[type="checkbox"][required]');
        const completeSignUpBtn = page.getByRole('button', { name: 'Complete sign up' });

        await firstNameInput.waitFor({ state: 'visible', timeout: 5000 });
        await firstNameInput.fill(SIGNUP_FIRST_NAME);
        await lastNameInput.fill(SIGNUP_LAST_NAME);
        await passwordInput.fill(SIGNUP_PASSWORD);
        await confirmPasswordInput.fill(SIGNUP_PASSWORD);

        await page.screenshot({ path: 'screenshots/09-profile-filled.png' });

        // Check the Terms of Service / Privacy Policy checkbox
        await termsCheckbox.check();
        const isChecked = await termsCheckbox.isChecked();
        console.log(`Terms checkbox checked: ${isChecked}`);
        await page.screenshot({ path: 'screenshots/10-terms-checked.png' });

        // --- Step 10: Submit "Complete sign up" ---
        await completeSignUpBtn.waitFor({ state: 'visible', timeout: 5000 });
        await completeSignUpBtn.click();
        console.log('Complete sign up button clicked.');

        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'screenshots/11-signup-complete.png' });

        console.log('Full flow completed: signup → email verified → profile completed.');
        console.log(`Account credentials — Email: ${tempEmail.address} | Password: ${SIGNUP_PASSWORD}`);
    } catch (err) {
        console.error('Error during flow:', err);
        await page.screenshot({ path: 'screenshots/99-error.png' });
        throw err;
    } finally {
        await page.waitForTimeout(5000);
        await browser.close();
    }
})();