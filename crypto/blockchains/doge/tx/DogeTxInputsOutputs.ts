/**
 * @version 0.20
 */
import { BlocksoftBlockchainTypes } from '../../BlocksoftBlockchainTypes'
import BlocksoftBN from '../../../common/BlocksoftBN'
import BlocksoftUtils from '../../../common/BlocksoftUtils'
import BlocksoftCryptoLog from '../../../common/BlocksoftCryptoLog'

const coinSelect = require('coinselect')
const coinSplit = require('coinselect/split')

export default class DogeTxInputsOutputs implements BlocksoftBlockchainTypes.TxInputsOutputs {
    private _builderSettings: BlocksoftBlockchainTypes.BuilderSettings
    private _settings: BlocksoftBlockchainTypes.CurrencySettings
    private _minOutputDust: any
    private _minChangeDust: any

    // in*148 + out*34 + 10 plus or minus 'in'
    SIZE_FOR_BASIC = 34
    SIZE_FOR_INPUT = 148

    constructor(settings: BlocksoftBlockchainTypes.CurrencySettings, builderSettings: BlocksoftBlockchainTypes.BuilderSettings) {
        this._settings = settings
        this._builderSettings = builderSettings
        this._minOutputDust = BlocksoftUtils.fromUnified(this._builderSettings.minOutputDustReadable, settings.decimals) // output amount that will be considered as "dust" so we dont need it
        this._minChangeDust = BlocksoftUtils.fromUnified(this._builderSettings.minChangeDustReadable, settings.decimals) // change amount that will be considered as "dust" so we dont need it
    }

    _coinSelectTargets(data: BlocksoftBlockchainTypes.TransferData, unspents: BlocksoftBlockchainTypes.UnspentTx[], feeForByte: string, multiAddress: string[], subtitle: string) {
        let targets
        if (data.isTransferAll) {
            targets = [{
                address: data.addressTo
            }]
        } else if (multiAddress.length === 0) {
            targets = [{
                address: data.addressTo,
                // @ts-ignore
                value: data.amount * 1
            }]
        } else {
            targets = []
            for (const address of multiAddress) {
                targets.push({
                    address: address,
                    // @ts-ignore
                    value: data.amount * 1
                })
            }
        }
        return targets
    }

    _usualTargets(data: BlocksoftBlockchainTypes.TransferData, unspents: BlocksoftBlockchainTypes.UnspentTx[] ) {
        const multiAddress = []
        const basicWishedAmountBN = new BlocksoftBN(data.amount)
        const wishedAmountBN = new BlocksoftBN(basicWishedAmountBN)

        const outputs = []
        if (data.addressTo.indexOf(';') === -1) {
            outputs.push({
                'to': data.addressTo,
                'amount': data.amount.toString()
            })
        } else {
            const addresses = data.addressTo.replace(/\s+/g, ';').split(';')
            let total = 0
            for (let i = 0, ic = addresses.length; i < ic; i++) {
                const address = addresses[i].trim()
                if (!address) continue
                outputs.push({
                    'to': address,
                    'amount': data.amount.toString()
                })
                multiAddress.push(address)
                if (total > 0) {
                    wishedAmountBN.add(basicWishedAmountBN)
                }
                total++
            }
        }
        return {
            multiAddress,
            basicWishedAmountBN,
            wishedAmountBN,
            outputs
        }
    }

    _coinSelect(data: BlocksoftBlockchainTypes.TransferData, unspents: BlocksoftBlockchainTypes.UnspentTx[], feeForByte: string, multiAddress: string[], subtitle: string)
        : BlocksoftBlockchainTypes.PreparedInputsOutputsTx {
        const utxos = []
        const isRequired: any = {}
        for (const unspent of unspents) {
            utxos.push({
                txId: unspent.txid,
                vout: unspent.vout,
                // @ts-ignore
                value: unspent.value * 1,
                my: unspent
            })
            if (unspent.isRequired && typeof isRequired[unspent.txid] === 'undefined') {
                isRequired[unspent.txid] = unspent
            }
        }

        const targets = this._coinSelectTargets(data, unspents, feeForByte, multiAddress, subtitle)
        let res
        if (data.isTransferAll) {
            res = coinSplit(utxos, targets, feeForByte)
        } else {
            res = coinSelect(utxos, targets, feeForByte)
        }
        const { inputs, outputs, fee } = res

        /*
        console.log('CS targets ' + feeForByte, JSON.parse(JSON.stringify(targets)))
        console.log('CS inputs', inputs ? JSON.parse(JSON.stringify(inputs)) : 'none')
        console.log('CS outputs', outputs ? JSON.parse(JSON.stringify(outputs)) : 'none')
        console.log('CS fee ', fee ? JSON.parse(JSON.stringify(fee)) : 'none')
        */
        const formatted = {
            inputs: [],
            outputs: [],
            multiAddress,
            msg: ' coinselect for ' + feeForByte + ' fee ' + fee + ' ' + subtitle + ' all data ' + JSON.stringify(inputs) + ' ' + JSON.stringify(outputs)
        }
        if (!inputs || typeof inputs === 'undefined') {
            // @ts-ignore
            return formatted
        }

        let input, output
        for (input of inputs) {
            // @ts-ignore
            formatted.inputs.push(input.my)
            if (typeof isRequired[input.my.txid] !== 'undefined') {
                delete isRequired[input.my.txid]
            }
        }
        const changeBN = new BlocksoftBN(0)
        let changeIsNeeded = false
        for (const txid in isRequired) {
            formatted.msg += ' txidAdded ' + txid
            // @ts-ignore
            formatted.inputs.push(isRequired[txid])
            changeBN.add(isRequired[txid].value * 1)
            changeIsNeeded = true
        }


        for (output of outputs) {
            if (output.address) {
                formatted.outputs.push({
                    // @ts-ignore
                    to: output.address,
                    // @ts-ignore
                    amount: output.value.toString()
                })
            } else if (data.addressFrom === data.addressTo) {
                changeIsNeeded = true
                changeBN.add(output.value)
            } else if (changeIsNeeded) {
                changeIsNeeded = false
                changeBN.add(output.value)
                formatted.outputs.push({
                    // @ts-ignore
                    to: data.addressFrom,
                    // @ts-ignore
                    amount: changeBN.toString(),
                    // @ts-ignore
                    isChange: true
                })
            } else {
                formatted.outputs.push({
                    // @ts-ignore
                    to: data.addressFrom,
                    // @ts-ignore
                    amount: output.value.toString(),
                    // @ts-ignore
                    isChange: true
                })
            }
        }

        if (changeIsNeeded) {
            // @ts-ignore
            if (this._builderSettings.changeTogether && typeof formatted.outputs[0] !== 'undefined' || data.addressFrom === data.addressTo && formatted.outputs[0].to === data.addressFrom) {
                // @ts-ignore
                changeBN.add(formatted.outputs[0].amount)
                // @ts-ignore
                formatted.outputs[0].amount = changeBN.toString()
            } else {
                formatted.outputs.push({
                    // @ts-ignore
                    to: data.addressFrom,
                    // @ts-ignore
                    amount: changeBN.toString(),
                    // @ts-ignore
                    isChange: true
                })
            }
        }

        // @ts-ignore
        return formatted
    }

    getInputsOutputs(data: BlocksoftBlockchainTypes.TransferData, unspents: BlocksoftBlockchainTypes.UnspentTx[],
                     feeToCount: { feeForByte?: string, feeForAll?: string, autoFeeLimitReadable?: string | number },
                     subtitle: string = 'default')
        : {
        inputs: BlocksoftBlockchainTypes.UnspentTx[],
        outputs: BlocksoftBlockchainTypes.OutputTx[],
        multiAddress: [],
        msg: string,
    } {
        if (typeof data.addressFrom === 'undefined') {
            throw new Error('DogeTxInputsOutputs.getInputsOutputs requires addressFrom')
        }
        if (typeof data.addressTo === 'undefined') {
            throw new Error('DogeTxInputsOutputs.getInputsOutputs requires addressTo')
        }
        if (typeof data.amount === 'undefined') {
            throw new Error('DogeTxInputsOutputs.getInputsOutputs requires amount')
        }

        const filteredUnspents = []
        const unconfirmedBN = new BlocksoftBN(0)


        const isRequired: any = {}
        let isFoundSpeedUp = false
        const filteredBN = new BlocksoftBN(0)
        for (const unspent of unspents) {
            if (typeof data.transactionSpeedUp !== 'undefined' && unspent.txid === data.transactionSpeedUp) {
                unspent.isRequired = true
                isFoundSpeedUp = true
            }
            if (unspent.isRequired) {
                filteredUnspents.push(unspent)
                filteredBN.add(unspent.value)
                if (unspent.isRequired && typeof isRequired[unspent.txid] === 'undefined') {
                    isRequired[unspent.txid] = unspent
                }
            } else {
                const diff = BlocksoftUtils.diff(unspent.value, this._minOutputDust)
                if (diff * 1 < 0) {
                    // skip as dust
                    // @ts-ignore
                    BlocksoftCryptoLog.log(this._settings.currencyCode + ' DogeTxInputsOutputs unspent skipped as dust ' + this._minOutputDust + ' diff ' + diff, unspent)
                } else if (!data.useOnlyConfirmed || unspent.confirmations > 0) {
                    filteredUnspents.push(unspent)
                    filteredBN.add(unspent.value)
                } else {
                    unconfirmedBN.add(unspent.value)
                }
            }
        }

        if (typeof data.transactionSpeedUp !== 'undefined' && !isFoundSpeedUp) {
            throw new Error('SERVER_RESPONSE_NO_TX_TO_SPEEDUP')
        }

        if (filteredUnspents.length === 0 && unspents.length !== 0) {
            throw new Error('SERVER_RESPONSE_WAIT_FOR_CONFIRM')
        }

        const totalBalanceBN = new BlocksoftBN(0)
        for (const unspent of filteredUnspents) {
            totalBalanceBN.add(unspent.value)
        }

        const {
            multiAddress,
            basicWishedAmountBN,
            wishedAmountBN,
            outputs
        } = this._usualTargets(data, unspents)

        if (typeof feeToCount.feeForByte !== 'undefined') {
            const result = this._coinSelect(data, filteredUnspents, feeToCount.feeForByte, multiAddress, subtitle)
            if (result.inputs.length > 0) {
                return result
            }
        }


        const ic = filteredUnspents.length
        let msg = 'v20 ' + subtitle + ' totalInputs ' + ic
            + ' totalBalance ' + totalBalanceBN.get() + ' = ' + BlocksoftUtils.toUnified(totalBalanceBN.get(), this._settings.decimals)
            + ' for wishedAmount ' + wishedAmountBN.get() + ' = ' + BlocksoftUtils.toUnified(wishedAmountBN.get(), this._settings.decimals)
        let autocalculateFee = false
        if (typeof feeToCount.feeForAll === 'undefined') {
            autocalculateFee = true
            msg += ' and autocalculate feeForByte ' + feeToCount.feeForByte
        } else {
            msg += ' and prefee ' + feeToCount.feeForAll + ' = ' + BlocksoftUtils.toUnified(feeToCount.feeForAll.toString(), this._settings.decimals)
        }


        const inputs = []
        const inputsBalanceBN = new BlocksoftBN(0)

        const wishedAmountWithFeeBN = new BlocksoftBN(wishedAmountBN)
        const autoFeeBN = new BlocksoftBN(0)
        if (autocalculateFee) {
            const tmp = BlocksoftUtils.mul(this.SIZE_FOR_BASIC, feeToCount.feeForByte)
            wishedAmountWithFeeBN.add(tmp)
            autoFeeBN.add(tmp)
            msg += ' auto => ' + BlocksoftUtils.toUnified(autoFeeBN.get(), this._settings.decimals)
        } else {
            wishedAmountWithFeeBN.add(feeToCount.feeForAll)
        }

        for (let i = 0; i < ic; i++) {
            if (!data.isTransferAll) {
                const tmp = new BlocksoftBN(wishedAmountWithFeeBN).diff(inputsBalanceBN)
                if (tmp.lessThanZero()) {
                    msg += ' finished by collectedAmount ' + inputsBalanceBN.get() + ' = ' + BlocksoftUtils.toUnified(inputsBalanceBN.get(), this._settings.decimals)
                    msg += ' on wishedAmountWithFee ' + wishedAmountWithFeeBN.get() + ' = ' + BlocksoftUtils.toUnified(wishedAmountWithFeeBN.get(), this._settings.decimals)
                    break
                }
            }
            const unspent = filteredUnspents[i]
            inputs.push(unspent)
            inputsBalanceBN.add(unspent.value)
            if (typeof isRequired[unspent.txid] !== 'undefined') {
                delete isRequired[unspent.txid]
            }
            if (autocalculateFee) {
                const tmp2 = BlocksoftUtils.mul(this.SIZE_FOR_INPUT, feeToCount.feeForByte)
                autoFeeBN.add(tmp2)
                wishedAmountWithFeeBN.add(tmp2)
                msg += ' auto => ' + BlocksoftUtils.toUnified(autoFeeBN.get(), this._settings.decimals)
            }
        }

        for (const txid in isRequired) {
            msg += ' txidAdded ' + txid
            inputs.push(isRequired[txid])
            inputsBalanceBN.add(isRequired[txid].value)
        }

        const leftForChangeDiff = new BlocksoftBN(inputsBalanceBN).diff(wishedAmountWithFeeBN)
        if (leftForChangeDiff.lessThanZero()) {
            if (autocalculateFee) {
                const newData = JSON.parse(JSON.stringify(data))
                const autoFeeLimit = BlocksoftUtils.fromUnified(feeToCount.autoFeeLimitReadable, this._settings.decimals)
                const autoDiff = new BlocksoftBN(autoFeeBN).diff(autoFeeLimit)

                let recountWithFee = autoFeeBN.get()
                if (autoDiff.lessThanZero()) {
                    recountWithFee = autoFeeLimit.toString()
                }

                const res = this.getInputsOutputs(newData, unspents, { feeForAll: recountWithFee }, subtitle + '  notEnough1 leftForChangeDiff ' + leftForChangeDiff.toString() + ' //// ')
                if (res.msg.indexOf('RECHECK') === -1) {
                    return res
                }
            } else if (subtitle.indexOf('notEnough1') !== -1) {
                const newData = JSON.parse(JSON.stringify(data))
                const tmp = leftForChangeDiff.get().replace('-', '')
                const tmp2 = new BlocksoftBN(data.amount).diff(tmp)
                if (!tmp2.lessThanZero()) {
                    newData.amount = tmp2.get()
                    return this.getInputsOutputs(newData, unspents, feeToCount, subtitle + '  notEnough3 ' + data.amount + ' => ' + newData.amount + ' leftForChangeDiff ' + leftForChangeDiff.toString() + ' //// ')
                } else {
                    // @ts-ignore
                    return {
                        inputs: [],
                        outputs: [],
                        msg: subtitle + '  notEnough3Stop' + data.amount + ' => ' + newData.amount + ' leftForChangeDiff ' + leftForChangeDiff.toString() + ' ' + msg,
                        // @ts-ignore
                        multiAddress
                    }
                }

            }
            // no change
            msg += ' will transfer all but later will RECHECK as change ' + leftForChangeDiff.toString()
            return {
                inputs,
                outputs,
                msg,
                // @ts-ignore
                multiAddress
            }
        }
        const changeDiff = new BlocksoftBN(leftForChangeDiff).diff(this._minChangeDust)
        if (changeDiff.lessThanZero()) {
            // no change
            msg += ' will transfer all as change ' + leftForChangeDiff.toString() + ' - dust = ' + changeDiff.toString()
            return {
                inputs,
                outputs,
                msg,
                // @ts-ignore
                multiAddress
            }
        }


        msg += ' will have change as change ' + leftForChangeDiff.toString() + ' = ' + BlocksoftUtils.toUnified(leftForChangeDiff.toString(), this._settings.decimals)
        if (this._builderSettings.changeTogether && data.addressFrom === data.addressTo) {
            leftForChangeDiff.add(outputs[0].amount)
            outputs[0].amount = leftForChangeDiff.toString()
        } else {
            outputs.push(
                {
                    'to': data.addressFrom,
                    'amount': leftForChangeDiff.toString(),
                    'isChange': true
                }
            )
        }
        return {
            inputs,
            outputs,
            msg,
            // @ts-ignore
            multiAddress
        }
    }
}
