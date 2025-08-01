import { LightningElement, track } from 'lwc';
import { loadScript } from 'lightning/platformResourceLoader';
import { NavigationMixin } from 'lightning/navigation';
import WALLET_SET_OBJECT from '@salesforce/schema/Wallet_Set__c';

import { labels } from './labels';
import { showToast, BIP32_PURPOSE, BIP32_COIN_TYPE, DERIVATION_PATHS, harden } from 'c/utils';

import cardanoLibrary from '@salesforce/resourceUrl/cardanoSerialization';
import bip39Library from '@salesforce/resourceUrl/bip39';

import checkAddressUsageOnly from '@salesforce/apex/CreateNewWalletCtrl.checkAddressUsageOnly';
import createUTXOAddressesBulk from '@salesforce/apex/CreateNewWalletCtrl.createUTXOAddressesBulk';
import createWallet from '@salesforce/apex/CreateNewWalletCtrl.createWallet';
import getNextAccountIndex from '@salesforce/apex/CreateNewWalletCtrl.getNextAccountIndex';
import isIndexValid from '@salesforce/apex/CreateNewWalletCtrl.isIndexValid';
import verifySeedPhrase from '@salesforce/apex/CreateNewWalletCtrl.verifySeedPhrase';

const TARGET_CONSECUTIVE_ADDRESSES = 20;

// BIP32 derivation path constants for Cardano
const BIP32_ACCOUNT_PATH = 0; // Account path
const BIP32_STAKE_PATH = 2;   // Stake path

// UI constants
const SUGGESTIONS_LIMIT = 5;
const FOCUS_DELAY = 100;
const BLUR_DELAY = 200;
const RETRY_DELAY = 2000;


export default class CreateNewWallet extends NavigationMixin(LightningElement) {
    labels = labels;
    walletSetObjectApiName = (typeof WALLET_SET_OBJECT === 'object' && WALLET_SET_OBJECT.objectApiName)
        ? WALLET_SET_OBJECT.objectApiName
        : WALLET_SET_OBJECT;

    cardano;
    @track librariesLoaded = false;
    @track selectedWalletSetId = '';
    @track walletName = '';
    @track accountIndex = '0';
    @track errorMessage = '';
    @track pickerErrorMessage = '';
    @track accountIndexErrorMessage = '';
    @track isLoading = false;
    @track currentStep = '';
    @track progressMessage = '';
    @track showSeedPhraseVerification = false;
    @track seedPhraseInputs = [];
    @track seedPhraseErrorMessage = '';
    @track seedPhraseWordCount = 24;    
    @track bip39WordList = [];
    @track suggestions = [];
    @track activeInputIndex = -1;

    get isCreateDisabled() {
        const isSeedPhraseValid = !this.showSeedPhraseVerification ||
            (
                this.seedPhraseInputs.length === this.seedPhraseWordCount &&
                this.seedPhraseInputs.every(input => input.value && input.value.trim().length > 0)
            );

        return !(
            this.selectedWalletSetId &&
            this.walletName.trim() &&
            this.accountIndex &&
            !isNaN(this.accountIndex) &&
            !this.accountIndexErrorMessage &&
            this.librariesLoaded &&
            !this.isLoading &&
            isSeedPhraseValid
        );
    }

    get buttonLabel() {
        return this.isLoading ? this.labels.UI.ButtonLabelCreating : this.labels.UI.ButtonLabel;
    }

    get progressDisplay() {
        if (this.isLoading && this.currentStep) {
            return `${this.currentStep}${this.progressMessage ? ': ' + this.progressMessage : ''}`;
        }
        return '';
    }

    get selectedWordCount() {
        return this.seedPhraseWordCount.toString();
    }

    get wordCountOptions() {
        return [
            { label: this.labels.WORD_COUNT.Option15, value: '15' },
            { label: this.labels.WORD_COUNT.Option24, value: '24' }
        ];
    }

    get showSuggestions() {
        return this.suggestions.length > 0 && this.activeInputIndex >= 0;
    }

    renderedCallback() {
        if (!this.librariesLoaded) {            
            this.loadLibraries();
        }
    }

    async loadLibraries() {
        const scripts = [
            { name: 'cardanoSerialization', url: `${cardanoLibrary}/cardanoSerialization/bundle.js` },
            { name: 'bip39', url: bip39Library }
        ];

        try {
            const loadResults = await Promise.all(
                scripts.map(async script => {
                    const result = await loadScript(this, script.url)
                        .then(() => {
                            return { name: script.name, loaded: true, url: script.url };
                        })
                        .catch(error => {
                            return { name: script.name, loaded: false, url: script.url, error };
                        });
                    return result;
                })
            );

            const failed = loadResults.filter(r => !r.loaded);
            if (failed.length) {
                throw new Error(this.labels.ERROR.LibraryLoading + ': ' + failed.map(f => f.name).join(', '));
            }

            this.librariesLoaded = true;
            
            // Initialize Cardano library reference
            this.cardano = window.cardanoSerialization;
            
            // Store BIP39 word list for autocomplete
            if (window.bip39 && window.bip39.wordlists && window.bip39.wordlists.english) {
                this.bip39WordList = window.bip39.wordlists.english;
            }

        } catch (error) {
            this.errorMessage = this.labels.ERROR.LibraryLoading + ': ' + (error.message || error);
            showToast(this, 'Error', this.errorMessage, 'error');
            setTimeout(() => this.loadLibraries(), RETRY_DELAY);
        }
    }

    async handleWalletSetChange(event) {
        const newWalletSetId = event.detail.recordId || '';
        const validation = this.validateWalletSetId(newWalletSetId);
        
        if (!validation.isValid) {
            this.pickerErrorMessage = validation.error;
            this.selectedWalletSetId = '';
            this.accountIndex = '0';
            this.accountIndexErrorMessage = '';
            this.showSeedPhraseVerification = false;
            this.seedPhraseInputs = [];
            this.seedPhraseErrorMessage = '';
            return;
        }
        
        this.selectedWalletSetId = newWalletSetId;
        this.pickerErrorMessage = '';
        
        if (newWalletSetId) {
            try {
                const nextIndex = await getNextAccountIndex({ walletSetId: newWalletSetId });
                this.accountIndex = String(nextIndex);
                this.accountIndexErrorMessage = '';
                
                // Initialize seed phrase verification
                await this.initializeSeedPhraseVerification();
            } catch (error) {
                this.handleError(error, this.labels.ERROR.FetchNextIndex);
                this.accountIndex = '0';
            }
        } else {
            this.accountIndex = '0';
            this.accountIndexErrorMessage = '';
            this.showSeedPhraseVerification = false;
            this.seedPhraseInputs = [];
            this.seedPhraseErrorMessage = '';
        }
    }

    async handleWalletNameChange(event) {
        this.walletName = event.target.value || '';
    }

    async handleAccountIndexChange(event) {
        const newIndex = event.target.value || '0';
        this.accountIndex = newIndex;
        
        // Client-side validation first
        const validation = this.validateAccountIndex(newIndex);
        if (!validation.isValid) {
            this.accountIndexErrorMessage = validation.error;
            return;
        }
        
        this.accountIndexErrorMessage = '';

        if (this.selectedWalletSetId) {
            try {
                const errorMessage = await isIndexValid({ walletSetId: this.selectedWalletSetId, accountIndex: parseInt(newIndex) });
                if (errorMessage) {
                    this.accountIndexErrorMessage = errorMessage;
                    showToast(this, 'Error', errorMessage, 'error');
                }
            } catch (error) {
                this.handleError(error, this.labels.ERROR.AccountIndexValidation);
            }
        }
    }

    async handleCreate() {
        this.errorMessage = '';
        this.isLoading = true;
        this.currentStep = this.labels.PROGRESS.Initializing;
        this.progressMessage = '';

        if (!this.librariesLoaded) {
            this.errorMessage = this.labels.ERROR.LibrariesNotLoaded;
            showToast(this, 'Error', this.errorMessage, 'error');
            this.isLoading = false;
            return;
        }

        if (!this.selectedWalletSetId) {
            this.pickerErrorMessage = this.labels.VALIDATION.PleaseSelectWalletSet;
            showToast(this, 'Error', this.pickerErrorMessage, 'error');
            this.isLoading = false;
            return;
        }
        
        if (this.showSeedPhraseVerification) {
            const enteredPhrase = this.seedPhraseInputs.map(input => input.value.trim()).join(' ');
            const wordCount = enteredPhrase.split(' ').length;
            if (!enteredPhrase || wordCount !== this.seedPhraseWordCount) {
                this.seedPhraseErrorMessage = `Please enter all ${this.seedPhraseWordCount} words correctly.`;
                showToast(this, 'Error', this.seedPhraseErrorMessage, 'error');
                this.isLoading = false;
                return;
            }

            try {
                this.currentStep = this.labels.PROGRESS.VerifyingSeedPhrase;
                this.progressMessage = this.labels.PROGRESS.CheckingServer;

                const isValid = await verifySeedPhrase({
                    walletSetId: this.selectedWalletSetId,
                    userSeedPhrase: enteredPhrase
                });

                if (!isValid) {
                    this.seedPhraseErrorMessage = this.labels.ERROR.SeedPhraseIncorrect;
                    showToast(this, 'Error', this.seedPhraseErrorMessage, 'error');
                    this.isLoading = false;
                    return;
                }
            } catch (error) {
                this.seedPhraseErrorMessage = error.body?.message || error.message;
                showToast(this, 'Error', this.seedPhraseErrorMessage, 'error');
                this.isLoading = false;
                return;
            }
        }

        try {
            await this.createWallet();
            showToast(this, 'Success', this.labels.SUCCESS.WalletCreated.replace('{0}', this.walletName), 'success');
            this.resetForm();
        } catch (error) {
            this.errorMessage = this.labels.ERROR.WalletCreation + ': ' + (error.message || error);
            showToast(this, 'Error', this.errorMessage, 'error');
        } finally {
            this.isLoading = false;
            this.currentStep = '';
            this.progressMessage = '';
        }
    }

    // Seed phrase verification methods
    async initializeSeedPhraseVerification() {
        if (!this.selectedWalletSetId) return;

        try {
            // Create input fields based on selected word count
            this.seedPhraseInputs = Array.from({ length: this.seedPhraseWordCount }, (_, index) => {
                return {
                    label: `Word ${index + 1}`,
                    value: '', // Empty input field - user must enter seed phrase
                    showSuggestions: false
                };
            });

            this.showSeedPhraseVerification = true;
            this.seedPhraseErrorMessage = '';
            this.suggestions = [];
            this.activeInputIndex = -1;
        } catch (error) {
            this.errorMessage = 'Failed to initialize seed phrase verification: ' + (error.message || error);
            showToast(this, 'Error', this.errorMessage, 'error');
        }
    }

    handleSeedPhraseWordCountChange(event) {
        this.seedPhraseWordCount = parseInt(event.target.value);
        
        // Reinitialize seed phrase inputs if verification is already shown
        if (this.showSeedPhraseVerification) {
            this.seedPhraseInputs = Array.from({ length: this.seedPhraseWordCount }, (_, index) => {
                return {
                    label: `Word ${index + 1}`,
                    value: '',
                    showSuggestions: false
                };
            });
            this.seedPhraseErrorMessage = '';
            this.suggestions = [];
            this.activeInputIndex = -1;
        }
    }

    handleSeedPhraseChange(event) {
        const index = parseInt(event.target.dataset.index);
        const value = event.target.value.toLowerCase().trim();
        
        this.seedPhraseInputs[index].value = value;
        this.seedPhraseInputs = [...this.seedPhraseInputs];
        this.activeInputIndex = index;
        this.seedPhraseErrorMessage = '';
        
        // Generate suggestions based on input
        if (value.length > 0 && this.bip39WordList.length > 0) {
            this.suggestions = this.bip39WordList.filter(word => 
                word.toLowerCase().startsWith(value)
            ).slice(0, SUGGESTIONS_LIMIT);
            this.seedPhraseInputs.forEach((input, i) => input.showSuggestions = (i === index));
        } else {
            this.suggestions = [];
            this.seedPhraseInputs.forEach(input => input.showSuggestions = false);
        }
    }

    // Method to handle suggestion selection
    handleSuggestionClick(event) {
        const selectedWord = event.currentTarget.dataset.word;
        const index = this.activeInputIndex;
        
        if (index >= 0 && index < this.seedPhraseInputs.length) {
            this.seedPhraseInputs[index].value = selectedWord;
            this.seedPhraseInputs = [...this.seedPhraseInputs];
            this.suggestions = [];
            this.seedPhraseInputs.forEach(input => input.showSuggestions = false);
            this.activeInputIndex = -1;
            
            // Focus on next input if available
            if (index < this.seedPhraseInputs.length - 1) {
                this.focusNextInput(index + 1);
            }
        }
    }

    // Method to focus on next input
    focusNextInput(index) {
        setTimeout(() => {
            const nextInput = this.template.querySelector(`[data-index="${index}"]`);
            if (nextInput) {
                nextInput.focus();
            }
        }, FOCUS_DELAY);
    }

    // Method to handle input focus
    handleSeedPhraseFocus(event) {
        const index = parseInt(event.target.dataset.index);
        this.activeInputIndex = index;
        
        // Show suggestions if there's a value
        const value = this.seedPhraseInputs[index].value.toLowerCase().trim();
        if (value.length > 0 && this.bip39WordList.length > 0) {
            this.suggestions = this.bip39WordList.filter(word => 
                word.toLowerCase().startsWith(value)
            ).slice(0, SUGGESTIONS_LIMIT);
            this.seedPhraseInputs.forEach((input, i) => input.showSuggestions = (i === index));
        } else {
            this.suggestions = [];
            this.seedPhraseInputs.forEach(input => input.showSuggestions = false);
        }
    }

    // Method to handle input blur
    handleSeedPhraseBlur() {
        // Delay hiding suggestions to allow for clicks
        setTimeout(() => {
            this.suggestions = [];
            this.seedPhraseInputs.forEach(input => input.showSuggestions = false);
            this.activeInputIndex = -1;
        }, BLUR_DELAY);
    }

    // Helper to verify private key matches address payment key hash
    verifyKeyMatch(utxoPrivateKey, addressBech32) {
        const derivedPubKeyHash = utxoPrivateKey.to_public().to_raw_key().hash().to_hex();
        const addressObj = this.cardano.Address.from_bech32(addressBech32);
        const addressKeyHash =
            this.cardano.BaseAddress.from_address(addressObj)?.payment_cred().to_keyhash()?.to_hex() ||
            this.cardano.EnterpriseAddress.from_address(addressObj)?.payment_cred().to_keyhash()?.to_hex();
        return derivedPubKeyHash === addressKeyHash;
    }

    /**
     * Enhanced address generation that ensures 20 consecutive unused addresses
     * Uses a three-phase approach to avoid DML + callout issues:
     * Phase 1: Derive addresses and check usage (callouts only)
     * Phase 2: Create all UTXO records in bulk (DML only)
     * Phase 3: Sync assets and transactions for each address (callouts + DML per address)
     */
    async generateAddressesUntilUnused(accountKey, derivationPath, accountIndexNum, stakeCred, network, paymentKeyHash, walletId) {
        const targetConsecutive = TARGET_CONSECUTIVE_ADDRESSES;
        const typeLabel = derivationPath === DERIVATION_PATHS.RECEIVING ? 'receiving' : 'change';

        this.updateProgress(`Generating ${typeLabel} addresses`, `Finding ${targetConsecutive} consecutive unused addresses...`);

        // Phase 1: Generate and check addresses
        const addresses = await this.generateAndCheckAddresses(
            accountKey, derivationPath, accountIndexNum, stakeCred, network, paymentKeyHash, typeLabel, targetConsecutive
        );

        // Phase 2: Create UTXO records
        await this.createUTXORecords(addresses, typeLabel, walletId);

        return addresses;
    }

    async generateAndCheckAddresses(accountKey, derivationPath, accountIndexNum, stakeCred, network, paymentKeyHash, typeLabel, targetConsecutive) {
        const addresses = [];
        let consecutiveUnused = 0;
        let index = 0;

        while (consecutiveUnused < targetConsecutive) {
            this.updateProgress(`Checking ${typeLabel} address #${index}`, 
                `Phase 1 - ${consecutiveUnused}/${targetConsecutive} consecutive unused found`);

            const addressData = await this.deriveAndVerifyAddress(
                accountKey, derivationPath, accountIndexNum, stakeCred, network, paymentKeyHash, index, typeLabel
            );

            const usageResult = await this.checkAddressUsage(addressData.address, index, typeLabel);
            
            if (usageResult.isUsed) {
                consecutiveUnused = 0;
            } else {
                consecutiveUnused++;
            }

            addresses.push({
                ...addressData,
                isUsed: usageResult.isUsed,
                usageResult: usageResult.result,
                usageError: usageResult.error
            });

            this.updateProgress(`Address #${index} ${usageResult.isUsed ? 'USED' : 'UNUSED'}`, 
                `${consecutiveUnused}/${targetConsecutive} consecutive unused`);
            
            index++;
        }

        return addresses;
    }

    async deriveAndVerifyAddress(accountKey, derivationPath, accountIndexNum, stakeCred, network, paymentKeyHash, index, typeLabel) {
        const privateKey = accountKey.derive(derivationPath).derive(index);
        const publicKey = privateKey.to_public();
        const keyHash = publicKey.to_raw_key().hash();
        const cred = this.cardano.Credential.from_keyhash(keyHash);

        const baseAddress = this.cardano.BaseAddress.new(
            network.network_id(),
            cred,
            stakeCred
        );
        const bech32Address = baseAddress.to_address().to_bech32();

        // Verify key match
        const keyMatch = this.verifyKeyMatch(privateKey, bech32Address);
        if (!keyMatch) {
            throw new Error(`Derived private key does not match address payment key hash for ${typeLabel} address #${index}`);
        }

        const fullPath = `m/${BIP32_PURPOSE}'/${BIP32_COIN_TYPE}'/${accountIndexNum}'/${derivationPath}/${index}`;
        
        return {
            index: index,
            publicKey: privateKey.to_public().to_bech32(), // xpub
            privateKey: privateKey.to_bech32(),            // xprv
            address: bech32Address,
            paymentKeyHash: publicKey.to_raw_key().hash().to_hex(),
            path: fullPath
        };
    }

    async checkAddressUsage(address, index, typeLabel) {
        try {
            this.updateProgress(`Checking ${typeLabel} address #${index}`, 'Checking blockchain for address usage...');
            
            const usageResult = await checkAddressUsageOnly({ address });
            const isUsed = usageResult.isUsed || false;
            
            return { isUsed, result: usageResult, error: null };
        } catch (error) {
            this.updateProgress(`Usage check failed for ${typeLabel} address #${index}`, 
                `Assuming unused due to error: ${error.message}`);
            
            return { isUsed: false, result: null, error: error.message };
        }
    }

    async createUTXORecords(addresses, typeLabel, walletId) {
        this.updateProgress(`Creating ${typeLabel} UTXO records`, 
            `Creating ${addresses.length} ${typeLabel} addresses in Salesforce...`);

        try {
            const createResult = await createUTXOAddressesBulk({
                walletId: walletId,
                receivingAddresses: typeLabel === 'receiving' ? addresses : [],
                changeAddresses: typeLabel === 'change' ? addresses : []
            });

            const addressResults = typeLabel === 'receiving' ? 
                createResult.receivingAddresses : 
                createResult.changeAddresses;

            // Merge creation results with address data
            for (let i = 0; i < addresses.length && i < addressResults.length; i++) {
                addresses[i].utxoAddressId = addressResults[i].utxoAddressId;
                addresses[i].createResult = addressResults[i];
            }

            this.updateProgress(`Successfully created ${addresses.length} ${typeLabel} addresses`);
        } catch (error) {
            throw new Error(`Failed to create ${typeLabel} UTXO records: ${error.message}`);
        }
    }


    async createWallet() {
        // Validate account index before proceeding
        const accountIndexNum = parseInt(this.accountIndex, 10);
        try {
            const errorMessage = await isIndexValid({ walletSetId: this.selectedWalletSetId, accountIndex: accountIndexNum });
            if (errorMessage) {
                throw new Error(errorMessage);
            }
        } catch (error) {
            throw new Error(this.labels.ERROR.AccountIndexValidation + ': ' + (error.body?.message || error.message));
        }

        // Use the seed phrase entered by user (already verified on server)
        const enteredPhrase = this.seedPhraseInputs.map(input => input.value.trim());
        let mnemonic = enteredPhrase.join(' ');
        
        if (!mnemonic) {
            throw new Error(this.labels.ERROR.SeedPhraseEmpty);
        }
        if (!window.bip39.validateMnemonic(mnemonic)) {
            throw new Error(this.labels.ERROR.InvalidMnemonic);
        }

        this.currentStep = this.labels.PROGRESS.DerivingKeys;
        const entropy = window.bip39.mnemonicToEntropy(mnemonic);
        const seed = Buffer.from(entropy, 'hex');
        const rootKey = this.cardano.Bip32PrivateKey.from_bip39_entropy(seed, Buffer.from(''));

        const accountKey = rootKey
            .derive(harden(BIP32_PURPOSE))
            .derive(harden(BIP32_COIN_TYPE))
            .derive(harden(accountIndexNum));

        const paymentPrivateKey = accountKey
            .derive(BIP32_ACCOUNT_PATH)
            .derive(BIP32_ACCOUNT_PATH);
        const paymentPublicKey = paymentPrivateKey.to_public();

        const stakePrivateKey = accountKey
            .derive(BIP32_STAKE_PATH)
            .derive(BIP32_ACCOUNT_PATH)
            .to_raw_key();
        const stakePublicKey = stakePrivateKey.to_public();
        const stakeKeyHash = stakePublicKey.hash();
        const stakeCred = this.cardano.Credential.from_keyhash(stakeKeyHash);

        const network = this.cardano.NetworkInfo.mainnet();

        this.currentStep = this.labels.PROGRESS.CreatingWallet;
        const paymentKeyHash = paymentPublicKey.to_raw_key().hash();
        const paymentCred = this.cardano.Credential.from_keyhash(paymentKeyHash);

        const baseAddress = this.cardano.BaseAddress.new(
            network.network_id(),
            paymentCred,
            stakeCred
        );
        const bech32Address = baseAddress.to_address().to_bech32();

        // Derive the bech32 stake address
        const stakeBaseAddress = this.cardano.RewardAddress.new(
            network.network_id(),
            stakeCred
        );
        const bech32StakeAddress = stakeBaseAddress.to_address().to_bech32();

        const recordId = await createWallet({
            walletSetId: this.selectedWalletSetId,
            walletName: this.walletName,
            address: bech32Address,
            accountPrivateKey: paymentPrivateKey.to_bech32(),
            accountPublicKey: paymentPublicKey.to_bech32(),
            accountIndex: accountIndexNum,
            stakeAddress: bech32StakeAddress
        });

        if (!recordId) {
            throw new Error(this.labels.ERROR.WalletRecordCreation);
        }

        // Generate receiving addresses with full syncing (usage check, creation, and asset/transaction sync)
        const receivingAddresses = await this.generateAddressesUntilUnused(
            accountKey,
            DERIVATION_PATHS.RECEIVING, // derivation path for receiving addresses
            accountIndexNum,
            stakeCred,
            network,
            paymentKeyHash,
            recordId
        );

        // Generate change addresses with full syncing (usage check, creation, and asset/transaction sync)
        const changeAddresses = await this.generateAddressesUntilUnused(
            accountKey,
            DERIVATION_PATHS.CHANGE, // derivation path for change addresses
            accountIndexNum,
            stakeCred,
            network,
            paymentKeyHash,
            recordId
        );

        this.currentStep = this.labels.PROGRESS.Finalizing;
        this.progressMessage = this.labels.PROGRESS.PreparingNavigation;

        // Navigate to the wallet record page
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: {
                recordId: recordId,
                objectApiName: 'Wallet__c',
                actionName: 'view'
            }
        }, true);
    }

    resetForm() {
        this.selectedWalletSetId = '';
        this.walletName = '';
        this.accountIndex = '0';
        this.errorMessage = '';
        this.pickerErrorMessage = '';
        this.accountIndexErrorMessage = '';
        this.currentStep = '';
        this.progressMessage = '';
        this.showSeedPhraseVerification = false;
        this.seedPhraseInputs = [];
        this.seedPhraseErrorMessage = '';
        this.seedPhraseWordCount = 24;
    }



    // Validation helper methods
    validateWalletSetId(walletSetId) {
        if (!walletSetId) return { isValid: false, error: this.labels.VALIDATION.PleaseSelectWalletSet };
        if (!/^[a-zA-Z0-9]{15,18}$/.test(walletSetId)) {
            return { isValid: false, error: this.labels.VALIDATION.InvalidWalletSetId };
        }
        return { isValid: true, error: '' };
    }

    validateAccountIndex(accountIndex) {
        if (!accountIndex || isNaN(accountIndex)) {
            return { isValid: false, error: this.labels.UI.AccountIndexMustBeNumber };
        }
        if (parseInt(accountIndex) < 0) {
            return { isValid: false, error: this.labels.UI.AccountIndexNonNegative };
        }
        return { isValid: true, error: '' };
    }

    // Error handling helper
    handleError(error, context = '') {
        const message = error.body?.message || error.message || this.labels.ERROR.Unknown;
        const fullMessage = context ? `${context}: ${message}` : message;
        this.errorMessage = fullMessage;
        showToast(this, 'Error', fullMessage, 'error');
        return fullMessage;
    }

    // Progress update helper
    updateProgress(step, message = '') {
        this.currentStep = step;
        this.progressMessage = message;
    }
}